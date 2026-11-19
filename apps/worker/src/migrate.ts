import { closeDb, logger, migrate } from '@lead/shared';

const applied = await migrate();
logger.info({ applied }, applied.length ? 'migrations applied' : 'database already up to date');
await closeDb();
