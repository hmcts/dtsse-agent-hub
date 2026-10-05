-- The PVC a StatefulSet makes from its `work` claim template for its one pod, named as Kubernetes names it. A generated
-- column's expression cannot be altered, so the column is dropped and added again; it had no constraints of its own.
ALTER TABLE "virtual_agent" DROP COLUMN "pvc_name";
ALTER TABLE "virtual_agent" ADD COLUMN "pvc_name" TEXT GENERATED ALWAYS AS ('work-va-' || left("id"::text, 8) || '-0') STORED;
