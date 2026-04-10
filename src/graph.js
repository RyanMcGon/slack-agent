import { StateGraph, MessagesAnnotation, Annotation, START, END, MemorySaver } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { buildSystemPrompt } from './prompts.js';
import { allTools } from './tools.js';
import { buildConfirmationBlocks, buildTaskListBlocks } from './slack-utils.js';

/*
 * LangGraph StateGraph for TaskLaunchpad
 *
 * Flow (per Slack message invocation):
 *
 *   START → agent
 *     ├─ text response (no tool) ────────────────→ respond → END
 *     ├─ create/update tool (no pendingAction) ──→ confirm_action → END
 *     ├─ list tool ──────────────────────────────→ execute_tool → format_response → END
 *     ├─ tool call + pendingAction (confirmed) ──→ execute_tool → format_response → END
 *     └─ text + pendingAction (declined) ────────→ cancel → END
 *
 * No graph cycles. Each Slack message = one START → END invocation.
 * State persists via checkpointer keyed on thread_ts.
 */

// Extended state: messages + task-specific context
const AgentState = Annotation.Root({
  ...MessagesAnnotation.spec,
  pendingAction: Annotation({
    reducer: (_, newVal) => newVal,
    default: () => null,
  }),
});

const MUTATING_TOOLS = new Set(['create_task', 'update_task', 'log_time']);

// Main agent — gpt-4o for better reasoning, tool-calling accuracy, and context understanding
function createModel() {
  return new ChatOpenAI({
    modelName: 'gpt-4o',
    temperature: 0.1,
  }).bindTools(allTools);
}

// Lightweight model for simple formatting tasks
function createLightModel() {
  return new ChatOpenAI({
    modelName: 'gpt-4o-mini',
    temperature: 0.3,
  });
}

// --- Helpers ---

/**
 * OpenAI requires every AIMessage with tool_calls to be immediately followed by
 * ToolMessages for EACH tool_call_id. This function scans the full history and
 * injects synthetic ToolMessages wherever a tool call is not answered by the
 * immediately following messages.
 */
function repairMessageHistory(messages) {
  const repaired = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    repaired.push(msg);

    if (msg._getType?.() === 'ai' && msg.tool_calls?.length > 0) {
      // Collect all tool_call_ids that need ToolMessage responses
      const unanswered = new Set(msg.tool_calls.map(tc => tc.id));

      // Look ahead — only consecutive ToolMessages can satisfy these calls
      let j = i + 1;
      while (j < messages.length && messages[j]._getType?.() === 'tool') {
        unanswered.delete(messages[j].tool_call_id);
        j++;
      }

      // Inject synthetic ToolMessages for any unanswered calls
      for (const tcId of unanswered) {
        repaired.push(new ToolMessage({ content: 'Cancelled by user.', tool_call_id: tcId }));
      }
    }
  }
  return repaired;
}

// --- Graph Nodes ---

async function agentNode(state, config) {
  const { userEmail, currentDate } = config.configurable || {};
  const systemPrompt = buildSystemPrompt({
    userEmail: userEmail || 'unknown',
    currentDate: currentDate ? new Date(currentDate) : new Date(),
  });

  const model = createModel();
  const messagesWithSystem = [
    new SystemMessage(systemPrompt),
    ...repairMessageHistory(state.messages),
  ];

  try {
    const response = await model.invoke(messagesWithSystem);
    return { messages: [response] };
  } catch (err) {
    if (err.message?.includes('rate') || err.status === 429) {
      // Retry once with backoff
      await new Promise(r => setTimeout(r, 2000));
      try {
        const response = await model.invoke(messagesWithSystem);
        return { messages: [response] };
      } catch (retryErr) {
        console.error(JSON.stringify({ event: 'openai_error', error: retryErr.message, retry: true }));
        return {
          messages: [new AIMessage("I'm having trouble thinking right now. Try again in a moment.")],
        };
      }
    }
    console.error(JSON.stringify({ event: 'openai_error', error: err.message }));
    return {
      messages: [new AIMessage("I'm having trouble thinking right now. Try again in a moment.")],
    };
  }
}

function respondNode(state) {
  // Terminal node: the last AI message is the text response.
  // Slack posting happens in index.js after graph invocation.
  return {};
}

function confirmActionNode(state) {
  const lastMessage = state.messages[state.messages.length - 1];
  const toolCall = lastMessage.tool_calls?.[0];
  if (!toolCall) return {};

  return {
    // Close the tool call immediately so the checkpoint always has valid history.
    // OpenAI requires every AIMessage(tool_calls) to be followed by ToolMessages.
    messages: [
      new ToolMessage({ content: 'Awaiting user confirmation.', tool_call_id: toolCall.id }),
    ],
    pendingAction: {
      tool: toolCall.name,
      args: toolCall.args,
      toolCallId: toolCall.id,
    },
  };
}

async function executeToolNode(state, config) {
  const pending = state.pendingAction;
  const lastMessage = state.messages[state.messages.length - 1];

  let toolName, toolArgs, toolCallId;

  if (pending) {
    // Confirmation path: use pending args but the LATEST AIMessage's tool_call_id,
    // since agentNode may have generated a new AIMessage(tool_calls) after the user confirmed.
    toolName = pending.tool;
    toolArgs = pending.args;
    const latestToolCall = lastMessage.tool_calls?.[0];
    toolCallId = latestToolCall?.id || pending.toolCallId;
  } else {
    // Direct path (list_tasks): execute from LLM's tool call
    const toolCall = lastMessage.tool_calls?.[0];
    if (!toolCall) return {};
    toolName = toolCall.name;
    toolArgs = toolCall.args;
    toolCallId = toolCall.id;
  }

  const toolMap = Object.fromEntries(allTools.map(t => [t.name, t]));
  const selectedTool = toolMap[toolName];
  if (!selectedTool) {
    return {
      messages: [new ToolMessage({ content: `Unknown tool: ${toolName}`, tool_call_id: toolCallId })],
      pendingAction: null,
    };
  }

  try {
    const result = await selectedTool.invoke(toolArgs, config);
    return {
      messages: [new ToolMessage({ content: result, tool_call_id: toolCallId })],
      pendingAction: null,
    };
  } catch (err) {
    console.error(JSON.stringify({ event: 'tool_error', tool: toolName, error: err.message }));
    return {
      messages: [new ToolMessage({ content: `Error: ${err.message}`, tool_call_id: toolCallId })],
      pendingAction: null,
    };
  }
}

async function formatResponseNode(state, config) {
  // Feed tool result back to LLM for a friendly confirmation message
  const { userEmail, currentDate } = config.configurable || {};
  const systemPrompt = buildSystemPrompt({
    userEmail: userEmail || 'unknown',
    currentDate: currentDate ? new Date(currentDate) : new Date(),
  });

  const model = createLightModel();
  const messagesWithSystem = [
    new SystemMessage(systemPrompt + '\n\nFormat the tool result as a friendly, concise Slack message confirming what happened.'),
    ...repairMessageHistory(state.messages),
  ];

  try {
    const response = await model.invoke(messagesWithSystem);
    return { messages: [response] };
  } catch (err) {
    // Fallback: templated response
    console.error(JSON.stringify({ event: 'format_response_error', error: err.message }));
    const lastToolMsg = [...state.messages].reverse().find(m => m._getType?.() === 'tool');
    const fallback = lastToolMsg ? `Done. Result: ${lastToolMsg.content.slice(0, 200)}` : 'Done.';
    return { messages: [new AIMessage(fallback)] };
  }
}

function cancelNode(state) {
  // Just clear pendingAction. The LLM's response from agentNode already
  // processed the user's message — don't overwrite it with a canned reply.
  return { pendingAction: null };
}

// --- Routing ---

function routeAfterAgent(state) {
  const lastMessage = state.messages[state.messages.length - 1];
  const hasToolCalls = lastMessage.tool_calls?.length > 0;
  const hasPending = state.pendingAction !== null;

  if (hasPending) {
    // User is responding to a confirmation
    if (hasToolCalls) {
      // LLM decided to execute (user confirmed) or call a new tool
      const toolName = lastMessage.tool_calls[0].name;
      if (toolName === state.pendingAction.tool) {
        // Same tool = confirmed, but we should use the pendingAction args
        return 'execute_tool';
      }
      // Different tool = new intent, treat as fresh (route based on tool type)
      if (MUTATING_TOOLS.has(toolName)) return 'confirm_action';
      return 'execute_tool';
    }
    // Text response while pending = decline/cancel
    return 'cancel';
  }

  if (!hasToolCalls) {
    return 'respond';
  }

  const toolName = lastMessage.tool_calls[0].name;
  if (MUTATING_TOOLS.has(toolName)) {
    return 'confirm_action';
  }
  return 'execute_tool';
}

// --- Graph Assembly ---

export function createGraph(checkpointer) {
  const graph = new StateGraph(AgentState)
    .addNode('agent', agentNode)
    .addNode('respond', respondNode)
    .addNode('confirm_action', confirmActionNode)
    .addNode('execute_tool', executeToolNode)
    .addNode('format_response', formatResponseNode)
    .addNode('cancel', cancelNode)
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', routeAfterAgent, {
      respond: 'respond',
      confirm_action: 'confirm_action',
      execute_tool: 'execute_tool',
      cancel: 'cancel',
    })
    .addEdge('respond', END)
    .addEdge('confirm_action', END)
    .addEdge('execute_tool', 'format_response')
    .addEdge('format_response', END)
    .addEdge('cancel', END);

  return graph.compile({ checkpointer });
}

/**
 * Initialize the checkpointer.
 * Uses PostgresSaver if SUPABASE_DB_URL is set, otherwise falls back to MemorySaver.
 */
export async function initCheckpointer() {
  const dbUrl = process.env.SUPABASE_DB_URL;
  if (dbUrl) {
    try {
      const checkpointer = PostgresSaver.fromConnString(dbUrl);
      await checkpointer.setup();
      console.log(JSON.stringify({ event: 'checkpointer_init', type: 'postgres' }));
      return checkpointer;
    } catch (err) {
      console.error(JSON.stringify({ event: 'checkpointer_init_error', error: err.message }));
      console.log(JSON.stringify({ event: 'checkpointer_init', type: 'memory', reason: 'postgres_fallback' }));
      return new MemorySaver();
    }
  }
  console.log(JSON.stringify({ event: 'checkpointer_init', type: 'memory' }));
  return new MemorySaver();
}
