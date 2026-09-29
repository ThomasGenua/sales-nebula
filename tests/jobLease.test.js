/**
 * A job runs once at a time, whoever asks (scheduler.withRetry takes a lease).
 *
 * Every process with node-cron runs the same schedule, and the admin "run now"
 * button is a second way in. Two runs at the same moment sent a sequence step
 * twice and raised a stale-deal alert twice. The jobs here are stand-ins added
 * to the handlers, so what is under test is the run-once rule and not any one
 * job.
 */
const { setup, teardown, cleanDatabase } = require('./setup');
const { runJob, setDatabaseClient, handlers } = require('../src/jobs/scheduler');

let prisma;
let runs;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

beforeAll(async () => {
  ({ prisma } = await setup());
  setDatabaseClient(prisma);
});
afterAll(async () => {
  delete handlers.probeSlow;
  delete handlers.probeFailing;
  await teardown();
});
beforeEach(async () => {
  await cleanDatabase();
  runs = 0;
  handlers.probeSlow = async () => { runs++; await sleep(300); return { ran: true }; };
  handlers.probeFailing = async () => { runs++; throw new Error('the job failed'); };
});

describe('running a job', () => {
  it('runs it once when several ask at the same moment, and tells the others it is already running', async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => runJob('probeSlow')));

    expect(runs).toBe(1);
    expect(results.filter(r => r.ran)).toHaveLength(1);
    expect(results.filter(r => r.skipped === 'already running')).toHaveLength(3);
  });

  it('runs it again once the last run has finished', async () => {
    await runJob('probeSlow');
    await runJob('probeSlow');
    expect(runs).toBe(2);
  });

  it('does not run it while another process holds the lease', async () => {
    await prisma.adminConfig.create({
      data: { key: 'lease:job:probeSlow', value: JSON.stringify({ token: 'other-process', expiresAt: Date.now() + 60000 }) },
    });

    expect(await runJob('probeSlow')).toEqual({ skipped: 'already running' });
    expect(runs).toBe(0);
  });

  it('takes over a lease whose holder died, once it has expired', async () => {
    await prisma.adminConfig.create({
      data: { key: 'lease:job:probeSlow', value: JSON.stringify({ token: 'dead-process', expiresAt: Date.now() - 1000 }) },
    });

    expect(await runJob('probeSlow')).toEqual({ ran: true });
    expect(runs).toBe(1);
  });

  it('keeps one job from holding up another', async () => {
    handlers.probeOther = async () => 'other';
    const [slow, other] = await Promise.all([runJob('probeSlow'), runJob('probeOther')]);
    delete handlers.probeOther;

    expect(slow).toEqual({ ran: true });
    expect(other).toBe('other');
  });

  it('lets go of the lease when the job fails, after its retries, so the next run can go ahead', async () => {
    await expect(runJob('probeFailing')).rejects.toThrow('the job failed');
    expect(runs).toBe(3); // three attempts

    expect(await prisma.adminConfig.count({ where: { key: 'lease:job:probeFailing' } })).toBe(0);
    handlers.probeFailing = async () => 'recovered';
    expect(await runJob('probeFailing')).toBe('recovered');
  }, 30000);

  it('still answers an unknown job with the error it always did', async () => {
    await expect(runJob('noSuchJob')).rejects.toThrow(/Unknown job: noSuchJob/);
  });
});
