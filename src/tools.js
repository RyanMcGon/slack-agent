import { createClient } from '@supabase/supabase-js';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// --- Lookup Helpers ---

/**
 * Look up a user's UUID, role, and profile by email.
 * Returns { id, role, email, full_name, ... } or null.
 */
export async function lookupUserByEmail(email) {
  const { data, error } = await supabase
    .from('users')
    .select('id, first_name, last_name, full_name, email, role')
    .ilike('email', email)
    .single();

  if (error || !data) return null;
  return data;
}

/**
 * Get the project IDs an Internal user has access to via project_contacts.
 */
export async function getProjectIdsForUser(userId) {
  const { data, error } = await supabase
    .from('project_contacts')
    .select('project_id')
    .eq('team_member', userId);

  if (error || !data) return [];
  return data.map(r => r.project_id);
}

/**
 * Get the milestone IDs an Internal user has access to via milestone_contacts.
 */
export async function getMilestoneIdsForUser(userId) {
  const { data, error } = await supabase
    .from('milestone_contacts')
    .select('milestone_id')
    .eq('milestone_contact', userId);

  if (error || !data) return [];
  return data.map(r => r.milestone_id);
}

/**
 * Look up a user by name (first, last, or full name).
 * Returns an array of matches (could be 0, 1, or multiple).
 */
export async function lookupUserByName(name) {
  const { data, error } = await supabase
    .from('users')
    .select('id, first_name, last_name, full_name, email')
    .or(`full_name.ilike.%${name}%,first_name.ilike.%${name}%,last_name.ilike.%${name}%`);

  if (error || !data) return [];
  return data;
}

/**
 * Look up milestones for a project, optionally filtered by a keyword in summary.
 * For Internal users, only returns milestones they're a contact on.
 * Returns an array (empty if none found).
 */
export async function lookupMilestonesByProject(projectId, searchTerm = null, { userRole, userId } = {}) {
  let query = supabase
    .from('milestones')
    .select('id, summary, number, status, start_date, completion_date')
    .eq('project_id', projectId)
    .order('number', { ascending: true });

  if (searchTerm) {
    query = query.ilike('summary', `%${searchTerm}%`);
  }

  // Internal users can only see milestones they're assigned to
  if (userRole === 'Internal' && userId) {
    const allowedIds = await getMilestoneIdsForUser(userId);
    if (allowedIds.length === 0) return [];
    query = query.in('id', allowedIds);
  }

  const { data, error } = await query;
  if (error || !data) return [];
  return data;
}

/**
 * Look up a project UUID by name.
 * For Internal users, only returns projects they're a contact on.
 * Returns null if not found.
 */
export async function lookupProjectByName(projectName, { userRole, userId } = {}) {
  let query = supabase
    .from('projects')
    .select('id, name')
    .ilike('name', `%${projectName}%`);

  // Internal users can only see projects they're assigned to
  if (userRole === 'Internal' && userId) {
    const allowedIds = await getProjectIdsForUser(userId);
    if (allowedIds.length === 0) return null;
    query = query.in('id', allowedIds);
  }

  const { data, error } = await query;

  if (error || !data || data.length === 0) return null;
  if (data.length === 1) return data[0];
  // Multiple matches — return all so the LLM can ask for clarification
  return data;
}

// --- LangGraph Tools ---

/**
 * create_task — INSERT into tasks table.
 * Accepts user email and project name, resolves to UUIDs internally.
 */
export const createTask = tool(
  async ({ name, description, due_date, priority, assignee_email, project_name, milestone_name, status, task_type }, config) => {
    const creatorEmail = config?.configurable?.userEmail;
    const userRole = config?.configurable?.userRole || 'Internal';
    const userId = config?.configurable?.userId;
    const roleCtx = { userRole, userId };

    // Resolve assignee email → UUID
    let assignedTo = null;
    if (assignee_email) {
      const user = await lookupUserByEmail(assignee_email);
      if (!user) {
        return JSON.stringify({ error: `Could not find user with email: ${assignee_email}` });
      }
      // Internal users can only assign to themselves
      if (userRole === 'Internal' && user.id !== userId) {
        return JSON.stringify({ error: 'You can only assign tasks to yourself.' });
      }
      assignedTo = user.id;
    }

    // Resolve creator email → UUID
    let createdBy = null;
    if (creatorEmail) {
      const creator = await lookupUserByEmail(creatorEmail);
      if (creator) createdBy = creator.id;
    }

    // Resolve project name → UUID (required)
    if (!project_name) {
      return JSON.stringify({ error: 'A project is required to create a task.' });
    }
    const project = await lookupProjectByName(project_name, roleCtx);
    if (!project) {
      return JSON.stringify({ error: `Could not find project "${project_name}" in the database. Please check the project name or you may not have access to it.` });
    }
    if (Array.isArray(project)) {
      return JSON.stringify({
        error: `Multiple projects match "${project_name}". Please be more specific.`,
        matches: project.map(p => p.name),
      });
    }
    const projectId = project.id;

    // Resolve milestone name → UUID (required)
    if (!milestone_name) {
      return JSON.stringify({ error: 'A milestone is required to create a task.' });
    }
    const milestoneMatches = await lookupMilestonesByProject(projectId, milestone_name, roleCtx);
    let milestoneId = null;
    if (milestoneMatches.length === 0) {
      // No match — return all milestones for this project so the user can pick
      const allMilestones = await lookupMilestonesByProject(projectId, null, roleCtx);
      return JSON.stringify({
        error: `Could not find milestone "${milestone_name}" in project "${project.name}". It may not exist or the name is incorrect.`,
        available_milestones: allMilestones.map(m => ({ number: m.number, summary: m.summary })),
      });
    } else if (milestoneMatches.length === 1) {
      milestoneId = milestoneMatches[0].id;
    } else {
      // Multiple fuzzy matches — find exact match or ask user to clarify
      const exact = milestoneMatches.find(
        m => m.summary?.toLowerCase() === milestone_name.toLowerCase() ||
             m.number?.toLowerCase() === milestone_name.toLowerCase()
      );
      if (exact) {
        milestoneId = exact.id;
      } else {
        return JSON.stringify({
          error: `Multiple milestones match "${milestone_name}" in project "${project.name}". Please be more specific.`,
          matches: milestoneMatches.map(m => ({ number: m.number, summary: m.summary })),
        });
      }
    }

    const { data, error } = await supabase
      .from('tasks')
      .insert({
        name,
        description: description || null,
        due_date: due_date || null,
        priority: priority || 'Medium',
        assigned_to: assignedTo,
        project_id: projectId,
        milestone_id: milestoneId,
        status: status || 'To Do',
        task_type: task_type || 'Work',
        created_by: createdBy,
      })
      .select(`
        *,
        assignee:users!assigned_to(full_name, email),
        project:projects!project_id(name),
        milestone:milestones!milestone_id(summary, number)
      `)
      .single();

    if (error) {
      console.error(JSON.stringify({ event: 'supabase_error', operation: 'create_task', error: error.message }));
      return JSON.stringify({ error: `Failed to create task: ${error.message}` });
    }

    console.log(JSON.stringify({ event: 'task_created', task_id: data.id, name: data.name }));
    return JSON.stringify({
      id: data.id,
      name: data.name,
      description: data.description,
      priority: data.priority,
      status: data.status,
      due_date: data.due_date,
      assignee: data.assignee?.full_name || null,
      project: data.project?.name || null,
      milestone: data.milestone?.summary || null,
      number: data.number,
    });
  },
  {
    name: 'create_task',
    description: 'Create a new task. Always confirm with the user before calling this. Both project_name and milestone_name are required — use list_milestones to verify the milestone exists before calling this.',
    schema: z.object({
      name: z.string().describe('Task name/title (required)'),
      description: z.string().optional().nullable().describe('Task description'),
      due_date: z.string().optional().nullable().describe('Due date in ISO 8601 format (e.g., 2026-04-10T00:00:00Z)'),
      priority: z.enum(['Low', 'Medium', 'High', 'Urgent']).optional().nullable().describe('Task priority, defaults to Medium'),
      assignee_email: z.string().optional().nullable().describe('Email of the person to assign this task to'),
      project_name: z.string().describe('Name of the project this task belongs to (required)'),
      milestone_name: z.string().describe('Summary or number of the milestone within the project (required) — must be verified via list_milestones first'),
      status: z.enum(['To Do', 'In Progress', 'Backlog', 'Not Started']).optional().nullable().describe('Task status, defaults to To Do'),
      task_type: z.enum(['Work', 'Meeting', 'Internal']).optional().nullable().describe('Task type, defaults to Work'),
    }),
  }
);

/**
 * list_tasks — SELECT with filters.
 * Defaults to current user's incomplete tasks.
 */
export const listTasks = tool(
  async ({ assignee_email, status, due_before, due_after, project_name, limit }, config) => {
    const userRole = config?.configurable?.userRole || 'Internal';
    const userId = config?.configurable?.userId;
    const roleCtx = { userRole, userId };

    let query = supabase
      .from('tasks')
      .select(`
        id, name, description, priority, status, due_date, task_type, number,
        assigned_to,
        assignee:users!assigned_to(full_name, email),
        project:projects!project_id(name)
      `);

    // Internal users can only see their own tasks
    if (userRole === 'Internal' && userId) {
      query = query.eq('assigned_to', userId);
    } else if (assignee_email) {
      // Resolve assignee email → UUID for filtering
      const user = await lookupUserByEmail(assignee_email);
      if (user) {
        query = query.eq('assigned_to', user.id);
      } else {
        return JSON.stringify({ error: `Could not find user with email: ${assignee_email}` });
      }
    }

    // Default: exclude completed/archived tasks
    if (status) {
      query = query.eq('status', status);
    } else {
      query = query.not('status', 'in', '("Completed","archived")');
    }

    // Exclude archived tasks
    query = query.eq('archived', false);

    if (due_before) {
      query = query.lte('due_date', due_before);
    }
    if (due_after) {
      query = query.gte('due_date', due_after);
    }

    // Resolve project name → UUID for filtering
    if (project_name) {
      const project = await lookupProjectByName(project_name, roleCtx);
      if (project && !Array.isArray(project)) {
        query = query.eq('project_id', project.id);
      } else if (Array.isArray(project)) {
        return JSON.stringify({
          error: `Multiple projects match "${project_name}". Please be more specific.`,
          matches: project.map(p => p.name),
        });
      }
    }

    query = query.order('due_date', { ascending: true, nullsFirst: false });
    query = query.limit(limit || 10);

    const { data, error } = await query;

    if (error) {
      console.error(JSON.stringify({ event: 'supabase_error', operation: 'list_tasks', error: error.message }));
      return JSON.stringify({ error: `Failed to list tasks: ${error.message}` });
    }

    console.log(JSON.stringify({ event: 'tasks_listed', count: data.length }));

    // Flatten the response for the LLM
    const tasks = data.map(t => ({
      id: t.id,
      name: t.name,
      description: t.description,
      priority: t.priority,
      status: t.status,
      due_date: t.due_date,
      task_type: t.task_type,
      number: t.number,
      assignee: t.assignee?.full_name || null,
      assignee_email: t.assignee?.email || null,
      project: t.project?.name || null,
    }));

    return JSON.stringify(tasks);
  },
  {
    name: 'list_tasks',
    description: 'List tasks with optional filters. Defaults to incomplete, non-archived tasks. Execute immediately without confirmation.',
    schema: z.object({
      assignee_email: z.string().optional().nullable().describe('Filter by assignee email'),
      status: z.enum(['To Do', 'In Progress', 'Completed', 'At Risk', 'On Hold', 'Backlog', 'Not Started', 'Blocked', 'QA Ready', 'submit_for_qa']).optional().nullable().describe('Filter by status'),
      due_before: z.string().optional().nullable().describe('Filter tasks due before this ISO 8601 date'),
      due_after: z.string().optional().nullable().describe('Filter tasks due after this ISO 8601 date'),
      project_name: z.string().optional().nullable().describe('Filter by project name'),
      limit: z.number().optional().nullable().describe('Maximum number of tasks to return, defaults to 10'),
    }),
  }
);

/**
 * update_task — UPDATE by task ID (UUID).
 * The agent should call list_tasks first to resolve task names to IDs.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const updateTask = tool(
  async ({ task_id, name, description, due_date, priority, assignee_email, project_name, status }, config) => {
    const userRole = config?.configurable?.userRole || 'Internal';
    const userId = config?.configurable?.userId;
    const roleCtx = { userRole, userId };

    if (!UUID_RE.test(task_id)) {
      return JSON.stringify({ error: `"${task_id}" is not a valid UUID. Use list_tasks first to find the task's UUID "id" field — do not use the task number.` });
    }

    // Internal users can only update their own tasks
    if (userRole === 'Internal' && userId) {
      const { data: task } = await supabase.from('tasks').select('assigned_to').eq('id', task_id).single();
      if (!task || task.assigned_to !== userId) {
        return JSON.stringify({ error: 'You can only update tasks assigned to you.' });
      }
    }

    const updates = {};
    if (name != null) updates.name = name;
    if (description != null) updates.description = description;
    if (due_date != null) updates.due_date = due_date;
    if (priority != null) updates.priority = priority;
    if (status != null) updates.status = status;

    // Resolve assignee email → UUID
    if (assignee_email != null) {
      const user = await lookupUserByEmail(assignee_email);
      if (!user) {
        return JSON.stringify({ error: `Could not find user with email: ${assignee_email}` });
      }
      // Internal users can only assign to themselves
      if (userRole === 'Internal' && user.id !== userId) {
        return JSON.stringify({ error: 'You can only assign tasks to yourself.' });
      }
      updates.assigned_to = user.id;
    }

    // Resolve project name → UUID
    if (project_name != null) {
      const project = await lookupProjectByName(project_name, roleCtx);
      if (!project) {
        return JSON.stringify({ error: `Could not find project: ${project_name}` });
      }
      if (Array.isArray(project)) {
        return JSON.stringify({
          error: `Multiple projects match "${project_name}". Please be more specific.`,
          matches: project.map(p => p.name),
        });
      }
      updates.project_id = project.id;
    }

    if (Object.keys(updates).length === 0) {
      return JSON.stringify({ error: 'No fields to update' });
    }

    const { data, error } = await supabase
      .from('tasks')
      .update(updates)
      .eq('id', task_id)
      .select(`
        *,
        assignee:users!assigned_to(full_name, email),
        project:projects!project_id(name)
      `)
      .single();

    if (error) {
      console.error(JSON.stringify({ event: 'supabase_error', operation: 'update_task', error: error.message }));
      return JSON.stringify({ error: `Failed to update task: ${error.message}` });
    }

    if (!data) {
      return JSON.stringify({ error: `Task ${task_id} not found` });
    }

    console.log(JSON.stringify({ event: 'task_updated', task_id: data.id, updates: Object.keys(updates) }));
    return JSON.stringify({
      id: data.id,
      name: data.name,
      priority: data.priority,
      status: data.status,
      due_date: data.due_date,
      assignee: data.assignee?.full_name || null,
      project: data.project?.name || null,
      number: data.number,
    });
  },
  {
    name: 'update_task',
    description: 'Update an existing task by its UUID. Always confirm with the user before calling this. Use list_tasks first to find the task ID if the user refers to a task by name.',
    schema: z.object({
      task_id: z.string().describe('The UUID of the task to update (required)'),
      name: z.string().optional().nullable().describe('New task name'),
      description: z.string().optional().nullable().describe('New task description'),
      due_date: z.string().optional().nullable().describe('New due date in ISO 8601 format'),
      priority: z.enum(['Low', 'Medium', 'High', 'Urgent']).optional().nullable().describe('New priority'),
      assignee_email: z.string().optional().nullable().describe('New assignee email'),
      project_name: z.string().optional().nullable().describe('New project name'),
      status: z.enum(['To Do', 'In Progress', 'Completed', 'At Risk', 'On Hold', 'Backlog', 'Not Started', 'Blocked', 'QA Ready', 'submit_for_qa']).optional().nullable().describe('New status'),
    }),
  }
);

/**
 * Direct Supabase update for Mark Done button (bypasses LLM).
 */
export async function markTaskDone(taskId) {
  const { data, error } = await supabase
    .from('tasks')
    .update({ status: 'Completed' })
    .eq('id', taskId)
    .select('id, name, number')
    .single();

  if (error) {
    console.error(JSON.stringify({ event: 'supabase_error', operation: 'mark_done', error: error.message }));
    throw new Error(`Failed to mark task done: ${error.message}`);
  }

  if (!data) {
    throw new Error(`Task ${taskId} not found`);
  }

  console.log(JSON.stringify({ event: 'task_marked_done', task_id: taskId }));
  return data;
}

/**
 * list_milestones — Fetch milestones for a project, with optional keyword search.
 */
export const listMilestones = tool(
  async ({ project_name, search_term }, config) => {
    const userRole = config?.configurable?.userRole || 'Internal';
    const userId = config?.configurable?.userId;
    const roleCtx = { userRole, userId };

    const project = await lookupProjectByName(project_name, roleCtx);
    if (!project) {
      return JSON.stringify({ error: `Could not find project: ${project_name}` });
    }
    if (Array.isArray(project)) {
      return JSON.stringify({
        error: `Multiple projects match "${project_name}". Please be more specific.`,
        matches: project.map(p => p.name),
      });
    }

    const milestones = await lookupMilestonesByProject(project.id, search_term || null, roleCtx);

    if (milestones.length === 0) {
      return JSON.stringify({
        message: `No milestones found for project "${project.name}"${search_term ? ` matching "${search_term}"` : ''}.`,
        project: project.name,
      });
    }

    console.log(JSON.stringify({ event: 'milestones_listed', project_id: project.id, count: milestones.length }));
    return JSON.stringify({
      project: project.name,
      milestones: milestones.map(m => ({
        id: m.id,
        number: m.number,
        summary: m.summary,
        status: m.status,
        start_date: m.start_date,
        completion_date: m.completion_date,
      })),
    });
  },
  {
    name: 'list_milestones',
    description: 'List or search milestones within a project. Use this to help the user find the right milestone before creating a task, or when the user asks to see milestones for a project.',
    schema: z.object({
      project_name: z.string().describe('Name of the project to list milestones for'),
      search_term: z.string().optional().describe('Optional keyword to filter milestones by their summary/title'),
    }),
  }
);

/**
 * log_time — INSERT into time_entries table.
 */
export const logTime = tool(
  async ({ task_id, time_logged, time_summary, description, type, sub_type, billable, logged_at }, config) => {
    const userRole = config?.configurable?.userRole || 'Internal';
    const userId = config?.configurable?.userId;

    if (!UUID_RE.test(task_id)) {
      return JSON.stringify({ error: `"${task_id}" is not a valid UUID. Use list_tasks first to find the task's UUID "id" field — do not use the task number.` });
    }

    // Internal users can only log time on their own tasks
    if (userRole === 'Internal' && userId) {
      const { data: task } = await supabase.from('tasks').select('assigned_to').eq('id', task_id).single();
      if (!task || task.assigned_to !== userId) {
        return JSON.stringify({ error: 'You can only log time on tasks assigned to you.' });
      }
    }

    const creatorEmail = config?.configurable?.userEmail;

    // Resolve creator email → UUID
    let creatorId = null;
    if (creatorEmail) {
      const creator = await lookupUserByEmail(creatorEmail);
      if (creator) creatorId = creator.id;
    }

    const { data, error } = await supabase
      .from('time_entries')
      .insert({
        task_id,
        user_id: creatorId,
        created_by: creatorId,
        time_logged,
        time_summary,
        description,
        type: type || 'Work',
        sub_type: sub_type || type || 'Work',
        billable: billable ?? true,
        logged_at: logged_at || new Date().toISOString(),
      })
      .select(`
        *,
        task:tasks!task_id(name, number)
      `)
      .single();

    if (error) {
      console.error(JSON.stringify({ event: 'supabase_error', operation: 'log_time', error: error.message }));
      return JSON.stringify({ error: `Failed to log time: ${error.message}` });
    }

    console.log(JSON.stringify({ event: 'time_logged', entry_id: data.id, task_id }));
    return JSON.stringify({
      id: data.id,
      task: data.task?.name || null,
      task_number: data.task?.number || null,
      time_logged: data.time_logged,
      time_summary: data.time_summary,
      description: data.description,
      type: data.type,
      billable: data.billable,
      logged_at: data.logged_at,
    });
  },
  {
    name: 'log_time',
    description: 'Log time against a task. Always confirm with the user before calling this. Use list_tasks first to find the task ID if the user refers to a task by name. REQUIRED: must have time_summary and description before calling — ask the user if missing.',
    schema: z.object({
      task_id: z.string().describe('The UUID of the task to log time against (required)'),
      time_logged: z.string().describe('Amount of time in decimal hours (e.g. "0.25" for 15 min, "0.50" for 30 min, "1.00" for 1 hour, "1.50" for 1h 30m)'),
      time_summary: z.string().describe('Short title summarising what was worked on (required)'),
      description: z.string().describe('Detailed description of the work done (required)'),
      type: z.enum(['Work', 'Meeting', 'Internal']).optional().describe('Time entry type, defaults to Work'),
      sub_type: z.enum(['Work', 'Meeting', 'Internal']).optional().describe('Time entry sub-type, defaults to match type'),
      billable: z.boolean().optional().describe('Whether this time is billable, defaults to true'),
      logged_at: z.string().optional().describe('When the time was logged, ISO 8601. Defaults to now.'),
    }),
  }
);

export const allTools = [createTask, listTasks, updateTask, logTime, listMilestones];
