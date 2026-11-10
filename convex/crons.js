import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();
crons.interval('drop stale presence and expired sessions', { minutes: 1 }, internal.presence.cleanup, {});
crons.interval('drop expired OAuth codes', { hours: 1 }, internal.oauth.cleanup, {});
crons.interval('drop change-feed events older than 30 days', { hours: 6 }, internal.events.cleanup, {});
export default crons;
