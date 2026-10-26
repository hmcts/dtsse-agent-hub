-- Why a failed agent failed, kept for its owner to read after the sweep has stopped it. `status_detail` cannot hold
-- it: a stop leaves the status `stopping`, and the orchestrator's observation of the stopped StatefulSet then clears
-- the detail, because for every other status it describes a pod that is no longer there. Why an agent failed stays
-- true once its pod is gone, so it is kept here, where only a start clears it.
ALTER TABLE "virtual_agent" ADD COLUMN "stop_detail" TEXT;
