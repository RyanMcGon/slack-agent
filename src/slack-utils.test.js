import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildConfirmationBlocks,
  buildTaskListBlocks,
  getUserEmail,
  getLastAIMessageText,
  resolveThreadTs,
} from './slack-utils.js';

describe('buildConfirmationBlocks', () => {
  it('renders create task with all fields', () => {
    const blocks = buildConfirmationBlocks('create_task', {
      name: 'Fix login bug',
      priority: 'High',
      assignee_email: 'sarah@company.com',
      due_date: '2026-04-15T00:00:00Z',
      project_name: 'Backend',
    });

    assert.ok(blocks.length >= 2);
    assert.ok(blocks[0].text.text.includes('Create task'));
    assert.ok(blocks[0].text.text.includes('Fix login bug'));

    // Check for confirm/cancel buttons
    const actionsBlock = blocks.find(b => b.type === 'actions');
    assert.ok(actionsBlock);
    assert.equal(actionsBlock.elements.length, 2);
    assert.equal(actionsBlock.elements[0].action_id, 'confirm_action');
    assert.equal(actionsBlock.elements[1].action_id, 'cancel_action');
  });

  it('renders update task with truncated UUID', () => {
    const blocks = buildConfirmationBlocks('update_task', {
      name: 'Fix login bug',
      task_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      status: 'Completed',
    });

    assert.ok(blocks[0].text.text.includes('Update task'));
    const fieldsBlock = blocks.find(b => b.fields);
    assert.ok(fieldsBlock);
    const taskIdField = fieldsBlock.fields.find(f => f.text.includes('a1b2c3d4'));
    assert.ok(taskIdField);
  });

  it('truncates long names to 150 chars', () => {
    const longName = 'A'.repeat(200);
    const blocks = buildConfirmationBlocks('create_task', { name: longName });

    assert.ok(blocks[0].text.text.length < 200);
    assert.ok(blocks[0].text.text.includes('...'));
  });
});

describe('buildTaskListBlocks', () => {
  it('renders multiple tasks with priority badges', () => {
    const tasks = [
      { id: 'uuid-1', name: 'Fix bug', priority: 'High', status: 'To Do', due_date: null, assignee: null, project: null, number: 'TSK-001' },
      { id: 'uuid-2', name: 'Write docs', priority: 'Low', status: 'In Progress', due_date: '2026-04-20T00:00:00Z', assignee: 'Mike Johnson', project: 'Docs', number: 'TSK-002' },
    ];

    const blocks = buildTaskListBlocks(tasks);

    // Header + 2 task sections
    assert.ok(blocks.length >= 3);
    assert.ok(blocks[0].type === 'header');
    assert.ok(blocks[0].text.text.includes('2'));

    // Check Mark Done button on first task
    const firstTask = blocks[1];
    assert.ok(firstTask.accessory);
    assert.equal(firstTask.accessory.action_id, 'mark_done');
    assert.equal(firstTask.accessory.value, 'uuid-1');

    // Check task number is used as label
    assert.ok(firstTask.text.text.includes('#TSK-001'));
  });

  it('renders empty state for zero tasks', () => {
    const blocks = buildTaskListBlocks([]);
    assert.equal(blocks.length, 1);
    assert.ok(blocks[0].text.text.includes('No tasks'));
  });

  it('renders empty state for null input', () => {
    const blocks = buildTaskListBlocks(null);
    assert.equal(blocks.length, 1);
    assert.ok(blocks[0].text.text.includes('No tasks'));
  });

  it('truncates long task names', () => {
    const tasks = [
      { id: 'uuid-1', name: 'B'.repeat(200), priority: 'Medium', status: 'To Do', due_date: null, assignee: null, project: null, number: null },
    ];

    const blocks = buildTaskListBlocks(tasks);
    const taskText = blocks[1].text.text;
    assert.ok(taskText.includes('...'));
  });

  it('does not show Mark Done on Completed tasks', () => {
    const tasks = [
      { id: 'uuid-1', name: 'Completed task', priority: 'Medium', status: 'Completed', due_date: null, assignee: null, project: null, number: null },
    ];

    const blocks = buildTaskListBlocks(tasks);
    assert.equal(blocks[1].accessory, undefined);
  });

  it('falls back to short UUID when no task number', () => {
    const tasks = [
      { id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890', name: 'No number', priority: 'Medium', status: 'To Do', due_date: null, assignee: null, project: null, number: null },
    ];

    const blocks = buildTaskListBlocks(tasks);
    assert.ok(blocks[1].text.text.includes('a1b2c3d4'));
  });
});

describe('getUserEmail', () => {
  it('returns email from Slack API', async () => {
    const mockClient = {
      users: {
        info: mock.fn(async () => ({ user: { profile: { email: 'test@example.com' } } })),
      },
    };

    const email = await getUserEmail(mockClient, 'U_NEW_USER_2');
    assert.equal(email, 'test@example.com');
  });

  it('falls back to user ID on API error', async () => {
    const mockClient = {
      users: {
        info: mock.fn(async () => { throw new Error('user_not_found'); }),
      },
    };

    const email = await getUserEmail(mockClient, 'U_FALLBACK_2');
    assert.equal(email, 'U_FALLBACK_2');
  });
});

describe('resolveThreadTs', () => {
  it('uses thread_ts when present', () => {
    assert.equal(resolveThreadTs({ thread_ts: '111', ts: '222' }), '111');
  });

  it('falls back to ts when no thread_ts', () => {
    assert.equal(resolveThreadTs({ ts: '333' }), '333');
  });
});

describe('getLastAIMessageText', () => {
  it('returns last AI message content', () => {
    const messages = [
      { _getType: () => 'human', content: 'hello' },
      { _getType: () => 'ai', content: 'response 1' },
      { _getType: () => 'tool', content: '{}' },
      { _getType: () => 'ai', content: 'response 2' },
    ];
    assert.equal(getLastAIMessageText(messages), 'response 2');
  });

  it('returns null when no AI messages', () => {
    const messages = [
      { _getType: () => 'human', content: 'hello' },
    ];
    assert.equal(getLastAIMessageText(messages), null);
  });
});
