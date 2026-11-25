// Paths are for the current signed-in session. Query variants share the same write dependencies.
export function staffReadAffected(writePath: string, readPath: string): boolean {
  const read = readPath.split('?')[0];
  if (writePath === '/api/coach/me/avatar') return read === '/api/coach/me/schedule';
  const prefix = '/api/admin/';
  if (!writePath.startsWith(prefix) || !read.startsWith(prefix)) return false;
  const [write, id, field] = writePath.slice(prefix.length).split('/');
  const [resource, readId, readField] = read.slice(prefix.length).split('/');
  switch (write) {
    case 'announcements': return resource === 'announcements';
    case 'course-types':
      return resource === 'course-types' || resource === 'coaches';
    case 'registrations':
      return ['registrations', 'parents', 'overview', 'player-links','player-search','account-roles'].includes(resource);
    case 'player-links':
      return ['player-links', 'parents', 'account-roles'].includes(resource);
    case 'account-roles':
      return resource === 'account-roles' || resource === 'guardian-search';
    case 'parents':
      return (resource === 'parents' && (!readId || readId === id)) || resource === 'player-search' ||
        (field === 'jersey' && resource === 'registrations');
    case 'accounts':
      return field === 'ledger' && (['parents', 'users'].includes(resource) ||
        (resource === 'accounts' && readId === id && !readField));
    case 'schedule':
    case 'bookings':
      return id !== 'quote' && (['overview', 'bookings', 'accounts', 'users', 'parents', 'classes', 'schedule'].includes(resource) ||
        (resource === 'coaches' && readField === 'slots'));
    case 'classes':
    case 'class-sessions':
    case 'class-templates':
      return ['classes', 'schedule', 'class-templates', 'overview'].includes(resource) ||
        (resource === 'coaches' && readField === 'slots');
    case 'coaches':
      if (field === 'hours' || field === 'exceptions') {
        return resource === 'coaches' && readId === id && (readField === 'hours' || readField === 'slots');
      }
      return ['context', 'class-templates', 'classes', 'schedule', 'bookings', 'overview'].includes(resource) ||
        (resource === 'accounts' && readField === 'bookings') ||
        (resource === 'coaches' && (!readId || readId === id));
    default:
      return false;
  }
}
