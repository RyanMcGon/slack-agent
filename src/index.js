import 'dotenv/config';
import pkg from '@slack/bolt';
const { App } = pkg;
import { HumanMessage, AIMessage } from '@langchain/core/messages';
import { createGraph, initCheckpointer } from './graph.js';
import { markTaskDone, allTools } from './tools.js';
import {
  getUserEmail,
  buildConfirmationBlocks,
  getLastAIMessageText,
  resolveThreadTs,
} from './slack-utils.js';

// --- App Initialization ---

const useSocketMode = Boolean(process.env.SLACK_APP_TOKEN);

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  ...(useSocketMode
    ? { socketMode: true, appToken: process.env.SLACK_APP_TOKEN }
    : { port: Number(process.env.PORT) || 3000 }),
});

let compiledGraph;

async function initGraph() {
  const checkpointer = await initCheckpointer();
  compiledGraph = createGraph(checkpointer);
  console.log(JSON.stringify({ event: 'graph_init', status: 'ready' }));
}

// --- Core: Invoke Graph ---

async function invokeAgent({ messages, threadTs, channelId, userEmail, say }) {
  const currentDate = new Date().toISOString();
  const config = {
    configurable: {
      thread_id: threadTs,
      userEmail,
      currentDate,
    },
  };

  console.log(JSON.stringify({
    event: 'graph_invoke',
    threadTs,
    channelId,
    userEmail,
    messageCount: messages.length,
  }));

  const startTime = Date.now();
  let result;
  try {
    result = await compiledGraph.invoke(
      { messages },
      config,
    );
  } catch (err) {
    console.error(JSON.stringify({ event: 'graph_error', error: err.message, threadTs }));
    await say({ text: "Something went wrong. Please try again.", thread_ts: threadTs });
    return;
  }

  const duration = Date.now() - startTime;
  console.log(JSON.stringify({ event: 'graph_complete', threadTs, duration_ms: duration }));

  // Check if the graph set a pendingAction (confirmation needed)
  if (result.pendingAction) {
    const blocks = buildConfirmationBlocks(result.pendingAction.tool, result.pendingAction.args);
    await say({ blocks, text: 'Please confirm this action.', thread_ts: threadTs });
    return;
  }

  // Check if the last tool result contains task list data
  const lastMessages = result.messages || [];
  const lastAIText = getLastAIMessageText(lastMessages);

  // Send the AI's text response
  if (lastAIText) {
    await say({ text: lastAIText, thread_ts: threadTs });
  }
}

// --- Handler 1: Slash Command ---

app.command('/taskagent', async ({ command, ack, client, say }) => {
  await ack();

  const userId = command.user_id;
  const channelId = command.channel_id;
  const text = command.text?.trim();

  if (!text) {
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text: 'Usage: `/taskagent <your request>` — e.g., `/taskagent create a task to fix the login bug`',
    });
    return;
  }

  try {
    const userEmail = await getUserEmail(client, userId);

    // Try posting to channel first; if bot isn't in the channel, use ephemeral + DM fallback
    let threadTs;
    let replyFn;
    try {
      const thinkingMsg = await client.chat.postMessage({
        channel: channelId,
        text: '🤔 Thinking...',
      });
      threadTs = thinkingMsg.ts;
      replyFn = (msg) => client.chat.postMessage({ channel: channelId, ...msg });

      await invokeAgent({ messages: [new HumanMessage(text)], threadTs, channelId, userEmail, say: replyFn });

      // Clean up thinking message
      try { await client.chat.delete({ channel: channelId, ts: thinkingMsg.ts }); } catch {}
    } catch (channelErr) {
      // Bot can't post in this channel — respond via DM
      console.log(JSON.stringify({ event: 'slash_fallback_dm', channelId, error: channelErr.message }));
      const dm = await client.conversations.open({ users: userId });
      const dmChannel = dm.channel.id;
      threadTs = Date.now().toString();
      replyFn = (msg) => client.chat.postMessage({ channel: dmChannel, ...msg });

      await replyFn({ text: '🤔 Thinking...' });
      await invokeAgent({ messages: [new HumanMessage(text)], threadTs, channelId: dmChannel, userEmail, say: replyFn });
    }
  } catch (err) {
    console.error(JSON.stringify({ event: 'slash_command_error', error: err.message }));
  }
});

// --- Handler 2: DM Messages ---

app.message(async ({ message, client, say }) => {
  // Only handle DMs (im channel type) and skip bot messages
  if (message.subtype || message.bot_id) return;
  if (message.channel_type !== 'im') return;

  // Skip non-text messages (files, images)
  if (!message.text?.trim()) {
    await say({ text: 'I can only process text messages.', thread_ts: resolveThreadTs(message) });
    return;
  }

  const threadTs = resolveThreadTs(message);
  const userEmail = await getUserEmail(client, message.user);

  // Post "Thinking..." indicator
  const thinkingMsg = await say({ text: '🤔 Thinking...', thread_ts: threadTs });

  await invokeAgent({
    messages: [new HumanMessage(message.text)],
    threadTs,
    channelId: message.channel,
    userEmail,
    say,
  });

  // Delete "Thinking..." message
  try {
    await client.chat.delete({ channel: message.channel, ts: thinkingMsg.ts });
  } catch {
    // Non-critical
  }
});

// --- Handler 3: @mentions ---

app.event('app_mention', async ({ event, client, say }) => {
  // Strip the bot mention from the text
  const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
  if (!text) return;

  const threadTs = resolveThreadTs(event);
  const userEmail = await getUserEmail(client, event.user);

  // Post "Thinking..." indicator
  const thinkingMsg = await say({ text: '🤔 Thinking...', thread_ts: threadTs });

  await invokeAgent({
    messages: [new HumanMessage(text)],
    threadTs,
    channelId: event.channel,
    userEmail,
    say,
  });

  // Delete "Thinking..." message
  try {
    await client.chat.delete({ channel: event.channel, ts: thinkingMsg.ts });
  } catch {
    // Non-critical
  }
});

// --- Handler 4a: Confirm Button ---

app.action('confirm_action', async ({ action, body, ack, client }) => {
  await ack();

  const channelId = body.channel?.id;
  const threadTs = body.message?.thread_ts || body.message?.ts;
  const userId = body.user?.id;
  const userEmail = await getUserEmail(client, userId);

  if (!threadTs || !channelId) return;

  // Load the graph state and execute the pending action
  const config = {
    configurable: {
      thread_id: threadTs,
      userEmail,
      currentDate: new Date().toISOString(),
    },
  };

  try {
    // Get current state from checkpointer
    const state = await compiledGraph.getState(config);
    const pending = state?.values?.pendingAction;

    if (!pending) {
      await client.chat.postMessage({
        channel: channelId,
        text: 'This action has already been processed or has expired.',
        thread_ts: threadTs,
      });
      return;
    }

    // Bypass the graph — execute the pending tool directly
    const toolMap = Object.fromEntries(allTools.map(t => [t.name, t]));
    const selectedTool = toolMap[pending.tool];

    if (!selectedTool) {
      await client.chat.postMessage({
        channel: channelId,
        text: `Unknown action: ${pending.tool}`,
        thread_ts: threadTs,
      });
      return;
    }

    const toolResult = await selectedTool.invoke(pending.args, config);
    const parsed = JSON.parse(toolResult);

    if (parsed.error) {
      await client.chat.postMessage({
        channel: channelId,
        text: `Failed: ${parsed.error}`,
        thread_ts: threadTs,
      });
      // Patch state — no ToolMessage needed since confirmActionNode already closed the tool call
      await compiledGraph.updateState(config, {
        messages: [
          new AIMessage(`Sorry, that failed: ${parsed.error}`),
        ],
        pendingAction: null,
      });
    } else {
      const label = parsed.number ? `#${parsed.number}` : (parsed.id?.slice(0, 8) || '');
      const taskName = parsed.name || parsed.time_summary || 'entry';
      const action = pending.tool === 'create_task' ? 'Created' : pending.tool === 'log_time' ? 'Logged time on' : 'Updated';
      const confirmText = `✅ ${action} *${[label, taskName].filter(Boolean).join(' ')}*`;

      await client.chat.postMessage({
        channel: channelId,
        text: confirmText,
        thread_ts: threadTs,
      });

      // Patch state — no ToolMessage needed since confirmActionNode already closed the tool call
      await compiledGraph.updateState(config, {
        messages: [
          new AIMessage(confirmText),
        ],
        pendingAction: null,
      });
    }

    console.log(JSON.stringify({ event: 'confirm_button_executed', tool: pending.tool, threadTs }));
  } catch (err) {
    console.error(JSON.stringify({ event: 'confirm_action_error', error: err.message, threadTs }));
    await client.chat.postMessage({
      channel: channelId,
      text: 'Something went wrong confirming this action. Please try again.',
      thread_ts: threadTs,
    });
  }
});

// --- Handler 4b: Cancel Button ---

app.action('cancel_action', async ({ action, body, ack, client }) => {
  await ack();

  const channelId = body.channel?.id;
  const threadTs = body.message?.thread_ts || body.message?.ts;
  const userId = body.user?.id;
  const userEmail = await getUserEmail(client, userId);

  if (!threadTs || !channelId) return;

  const config = {
    configurable: {
      thread_id: threadTs,
      userEmail,
      currentDate: new Date().toISOString(),
    },
  };

  try {
    // Invoke with a cancel message — the LLM will ask what they want to change
    const result = await compiledGraph.invoke(
      { messages: [new HumanMessage('No, cancel this.')] },
      config,
    );

    const lastAIText = getLastAIMessageText(result.messages || []);
    await client.chat.postMessage({
      channel: channelId,
      text: lastAIText || "No problem, cancelled. What would you like to change?",
      thread_ts: threadTs,
    });
  } catch (err) {
    console.error(JSON.stringify({ event: 'cancel_action_error', error: err.message, threadTs }));
    await client.chat.postMessage({
      channel: channelId,
      text: "Cancelled. Tell me what you'd like to change and I'll try again.",
      thread_ts: threadTs,
    });
  }
});

// --- Handler 4c: Mark Done Button ---

app.action('mark_done', async ({ action, body, ack, client }) => {
  await ack();

  const taskId = parseInt(action.value, 10);
  const channelId = body.channel?.id;
  const threadTs = body.message?.thread_ts || body.message?.ts;

  if (!taskId || !channelId) return;

  try {
    const task = await markTaskDone(taskId);
    const label = task.number ? `#${task.number}` : task.id.slice(0, 8);
    await client.chat.postMessage({
      channel: channelId,
      text: `✅ Marked task *${label} ${task.name}* as completed.`,
      thread_ts: threadTs,
    });
    console.log(JSON.stringify({ event: 'mark_done_button', task_id: taskId }));
  } catch (err) {
    console.error(JSON.stringify({ event: 'mark_done_error', task_id: taskId, error: err.message }));
    await client.chat.postMessage({
      channel: channelId,
      text: `Failed to mark task #${taskId} as done: ${err.message}`,
      thread_ts: threadTs,
    });
  }
});

// --- Startup ---

(async () => {
  await initGraph();
  await app.start();
  const mode = useSocketMode ? 'Socket Mode' : `HTTP on port ${process.env.PORT || 3000}`;
  console.log(JSON.stringify({ event: 'app_start', mode }));
  console.log(`⚡️ TaskLaunchpad is running (${mode})`);
})();
