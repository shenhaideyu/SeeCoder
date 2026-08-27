export function canAddTask(title) {
  return typeof title === 'string' && title.trim().length > 0;
}

export function filterTasks(tasks, status = 'all') {
  return status === 'all' ? tasks : tasks.filter((task) => task.status === status);
}
