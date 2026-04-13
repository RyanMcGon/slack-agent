# TaskLaunchpad Slack Agent

Conversational Slack agent for task management. Users create, list, update tasks and log time via natural language in Slack (slash commands, DMs, @mentions). Built with LangGraph for stateful agentic workflows.

## Stack

- **Runtime:** Node.js 20, ES modules (ESM)
- **Agent framework:** LangGraph (`@langchain/langgraph`) with OpenAI GPT-4o
- **Chat platform:** Slack Bolt (`@slack/bolt`) via Socket Mode
- **Database:** Supabase (PostgreSQL) for tasks, projects, milestones, time entries
- **Validation:** Zod schemas on all LLM-callable tools
- **Deployment:** Docker + Fly.io (worker process, no HTTP)

## Commands

```bash
npm install          # Install dependencies
npm start            # Run the agent (requires .env)
npm test             # Run tests (node:test)
```

No linter or formatter is configured.

## Architecture

```
src/
  index.js          # Slack app setup, event handlers (slash, DM, mention, buttons)
  graph.js          # LangGraph state machine (agent → confirm/execute → respond)
  tools.js          # LangChain tools: create_task, list_tasks, update_task, log_time, list_milestones
  prompts.js        # System prompt builder
  slack-utils.js    # Block Kit builders, user lookup, thread resolution
  slack-utils.test.js
```

**Graph flow:** Mutating tools (create/update/log_time) go through a confirmation step with Slack buttons. Read-only tools (list_tasks, list_milestones) execute immediately.

**State persistence:** Conversation history is checkpointed per Slack thread via `@langchain/langgraph-checkpoint-postgres`. Falls back to in-memory if `SUPABASE_DB_URL` is missing.

## Environment Variables

Required in `.env` (not committed):

- `SLACK_BOT_TOKEN` — Bot user token
- `SLACK_SIGNING_SECRET` — Request signature verification
- `SLACK_APP_TOKEN` — Socket Mode app token
- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_SERVICE_KEY` — Supabase service role key
- `SUPABASE_DB_URL` — PostgreSQL connection string (optional, for checkpointer)

## Conventions

- Async/await throughout; try-catch with structured JSON logging
- camelCase for functions/variables, SCREAMING_SNAKE for constants
- snake_case for file names and tool names
- Tests use Node.js built-in `node:test` module
- No TypeScript — pure JavaScript with Zod for runtime validation
