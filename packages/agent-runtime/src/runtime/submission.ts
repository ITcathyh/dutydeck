import { RuntimeError, type AgentDriver, type DriverSubmission, type DriverSubmissionInput, type SubmissionIntent } from '@dutydeck/shared';
import type { ControlledDriverResources } from '../driver-context.js';
import { digest } from '../digest.js';
import type { LocalDriverLedger } from '../ledger.js';

type Frozen = Omit<DriverSubmission, 'operation' | 'onAccepted'>;
type Run = (operation: () => Promise<void>) => Promise<void>;
interface TurnSubmission {
  prepare?(valid: () => boolean, run: Run): Promise<void>;
  freeze(check: () => void): Promise<SubmissionIntent>;
  send(run: Run, compact: (submission?: DriverSubmission) => Promise<boolean>, accepted: DriverSubmission['onAccepted']): Promise<void>;
}

/** The ledger records the provider's resource protocol when it creates the driver. */
export function turnSubmission(ledger: LocalDriverLedger, driver: AgentDriver, input: DriverSubmissionInput,
  supports: (key: keyof AgentDriver) => boolean): TurnSubmission {
  const controlled = ledger.get(driver)?.controlled;
  if (controlled) return controlledSubmission(controlled, driver, input, supports);
  return {
    async freeze(check) {
      const recovery = supports('checkpoint') ? await driver.checkpoint!() : undefined;
      check();
      return { submissionId: input.submissionId, inputDigest: digest({ prompt: input.prompt, executionOptions: input.executionOptions }),
        resourceRefs: ledger.refs(driver), authorizationRefs: [], ...(recovery && { recovery }) };
    },
    send: (run, compact) => run(async () => { if (await compact()) await driver.send(input.prompt); }),
  };
}

function controlledSubmission(resources: ControlledDriverResources, driver: AgentDriver, input: DriverSubmissionInput,
  supports: (key: keyof AgentDriver) => boolean): TurnSubmission {
  let frozen: Frozen;
  return {
    prepare: supports('prepareTurn') ? async (valid, run) => {
      const operation = resources.beginPreparation(valid);
      await run(async () => {
        try { await driver.prepareTurn!(input, operation); }
        finally { resources.endPreparation(operation); }
      });
    } : undefined,
    async freeze(check) {
      check();
      const prepared = supports('prepareSubmission') && driver.prepareSubmission!(input);
      if (!prepared) throw new RuntimeError('DRIVER_SUBMISSION_UNSUPPORTED', 'Controlled driver must freeze its submission', 409);
      frozen = prepared;
      return { submissionId: input.submissionId, inputDigest: frozen.inputDigest, resourceRefs: frozen.resourceRefs,
        authorizationRefs: [], driverInstanceId: resources.driverInstanceId,
        ...(frozen.nativeContextRef && { nativeContextRef: frozen.nativeContextRef, contextProofId: frozen.contextProofId }),
        ...(frozen.recovery && { recovery: frozen.recovery }) };
    },
    async send(run, compact, onAccepted) {
      const operation = resources.beginSubmission(frozen);
      await run(async () => {
        try {
          const submission = Object.freeze({ ...frozen, operation, onAccepted });
          if (await compact(submission)) await driver.send(submission);
        } finally { resources.endSubmission(operation); }
      });
    },
  };
}
