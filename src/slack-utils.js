/**
 * Slack utilities: Block Kit builders, user email resolution, message formatting.
 */

const PRIORITY_EMOJI = {
  urgent: '🔴',
  high: '🟠',
  medium: '🟡',
  low: '⚪',
};

// In-memory cache for user email lookups (per process lifetime)
const emailCache = new Map();

// Fallback mapping for when Slack API users:read.email scope is missing.
// Remove this once the scope is added and the app is reinstalled.
const SLACK_ID_TO_EMAIL = {
  'U088SPA9XV0': 'ryan@automatedxp.com',
};

/**
 * Resolve a Slack user ID to an email address via users.info API.
 * Caches results in-memory. Falls back to Slack user ID on error.
 */
export async function getUserEmail(client, userId) {
  if (emailCache.has(userId)) {
    return emailCache.get(userId);
  }

  try {
    const result = await client.users.info({ user: userId });
    const email = result.user?.profile?.email;
    if (email) {
      emailCache.set(userId, email);
      return email;
    }
  } catch (err) {
    console.warn(JSON.stringify({ event: 'slack_users_info_error', userId, error: err.message }));
  }

  // Fallback to hardcoded mapping if Slack API fails or returns no email
  const fallback = SLACK_ID_TO_EMAIL[userId] || userId;
  emailCache.set(userId, fallback);
  return fallback;
}

/**
 * Build Block Kit blocks for a task confirmation (create or update).
 * Includes Confirm and Cancel buttons.
 */
export function buildConfirmationBlocks(action, args) {
  if (action === 'log_time') {
    return buildLogTimeConfirmationBlocks(args);
  }

  const taskName = args.name || args.title || '(untitled)';
  const truncatedTitle = taskName.length > 150 ? taskName.slice(0, 147) + '...' : taskName;
  const isCreate = action === 'create_task';

  const fields = [];
  if (args.priority) fields.push(`*Priority:* ${PRIORITY_EMOJI[args.priority?.toLowerCase()] || ''} ${args.priority}`);
  if (args.assignee_email) fields.push(`*Assignee:* ${args.assignee_email}`);
  if (args.due_date) fields.push(`*Due:* ${formatDueDate(args.due_date)}`);
  if (args.project_name) fields.push(`*Project:* ${args.project_name}`);
  if (args.milestone_name) fields.push(`*Milestone:* ${args.milestone_name}`);
  if (args.status && args.status !== 'To Do') fields.push(`*Status:* ${args.status}`);
  if (args.task_type && args.task_type !== 'Work') fields.push(`*Type:* ${args.task_type}`);
  if (args.description) fields.push(`*Description:* ${args.description.slice(0, 100)}`);

  // For updates, show a short version of the UUID
  if (args.task_id) fields.push(`*Task ID:* ${args.task_id.slice(0, 8)}...`);

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: isCreate
          ? `📋 *Create task:* ${truncatedTitle}`
          : `✏️ *Update task:* ${truncatedTitle}`,
      },
    },
  ];

  if (fields.length > 0) {
    blocks.push({
      type: 'section',
      fields: fields.map(f => ({ type: 'mrkdwn', text: f })),
    });
  }

  blocks.push(confirmCancelActions());
  return blocks;
}

function buildLogTimeConfirmationBlocks(args) {
  const loggedAt = args.logged_at
    ? new Date(args.logged_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  const billable = args.billable !== false; // default true

  const fields = [
    `*Time Logged:* ${args.time_logged}`,
    `*Date:* ${loggedAt}`,
    `*Type:* ${args.type || 'Work'}`,
    `*Billable:* ${billable ? 'Yes' : 'No'}`,
    `*Title:* ${args.time_summary}`,
    `*Description:* ${args.description?.slice(0, 150) || ''}`,
  ];

  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `⏱️ *Log time on task*` },
    },
    {
      type: 'section',
      fields: fields.map(f => ({ type: 'mrkdwn', text: f })),
    },
    confirmCancelActions(),
  ];
}

function confirmCancelActions() {
  return {
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: '✅ Confirm' },
        style: 'primary',
        action_id: 'confirm_action',
      },
      {
        type: 'button',
        text: { type: 'plain_text', text: '❌ Cancel' },
        style: 'danger',
        action_id: 'cancel_action',
      },
    ],
  };
}

/**
 * Build Block Kit blocks for a task list.
 * Each task shows priority badge, due date, and a Mark Done button.
 */
export function buildTaskListBlocks(tasks) {
  if (!tasks || tasks.length === 0) {
    return [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '📭 No tasks match your criteria.' },
      },
    ];
  }

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `📋 Tasks (${tasks.length})` },
    },
  ];

  for (const task of tasks) {
    const priority = PRIORITY_EMOJI[task.priority?.toLowerCase()] || '⚪';
    const taskName = (task.name || task.title || '(untitled)');
    const displayName = taskName.length > 150 ? taskName.slice(0, 147) + '...' : taskName;
    const label = task.number ? `#${task.number}` : task.id.slice(0, 8);
    const duePart = task.due_date ? ` | 📅 ${formatDueDate(task.due_date)}` : '';
    const assigneePart = (task.assignee || task.assignee_email) ? ` | 👤 ${task.assignee || task.assignee_email}` : '';
    const projectPart = (task.project || task.project_name) ? ` | 📁 ${task.project || task.project_name}` : '';
    const statusBadge = formatStatus(task.status);

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${priority} *${label} ${displayName}*\n${statusBadge}${duePart}${assigneePart}${projectPart}`,
      },
      accessory: task.status !== 'Completed' ? {
        type: 'button',
        text: { type: 'plain_text', text: '✅ Done' },
        action_id: 'mark_done',
        value: String(task.id),
      } : undefined,
    });
  }

  return blocks;
}

function formatDueDate(isoDate) {
  if (!isoDate) return '';
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  if (diffDays < 0) return `⚠️ ${dateStr} (overdue)`;
  if (diffDays === 0) return `🔥 ${dateStr} (today)`;
  if (diffDays === 1) return `${dateStr} (tomorrow)`;
  return dateStr;
}

function formatStatus(status) {
  const map = {
    'To Do': '🔘 To Do',
    'In Progress': '🔄 In Progress',
    'Completed': '✅ Completed',
    'At Risk': '⚠️ At Risk',
    'On Hold': '⏸️ On Hold',
    'Backlog': '📥 Backlog',
    'Not Started': '⬜ Not Started',
    'Blocked': '🚫 Blocked',
    'QA Ready': '🔍 QA Ready',
    'submit_for_qa': '📤 Submitted for QA',
  };
  return map[status] || status;
}

/**
 * Extract the last AI message text from graph state for Slack posting.
 */
export function getLastAIMessageText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]._getType?.() === 'ai' && messages[i].content) {
      return messages[i].content;
    }
  }
  return null;
}

/**
 * Determine the thread_ts for a Slack event.
 * Uses thread_ts if present, falls back to message ts.
 */
export function resolveThreadTs(event) {
  return event.thread_ts || event.ts;
}
