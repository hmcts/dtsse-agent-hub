-- The pod reports the ports it finds listening, rather than the owner choosing them: `exposed_ports` are those the
-- Service can reach, `local_only_ports` those bound to loopback only, which the owner's page explains.
-- The checks repeat src/virtual-agents/ports.ts.
ALTER TABLE "virtual_agent" DROP CONSTRAINT "virtual_agent_exposed_ports_check";

ALTER TABLE "virtual_agent" ADD CONSTRAINT "virtual_agent_exposed_ports_check" CHECK (
  cardinality("exposed_ports") <= 10
  AND 1024 <= ALL ("exposed_ports")
  AND 65535 >= ALL ("exposed_ports")
);

ALTER TABLE "virtual_agent" ADD COLUMN "local_only_ports" integer[] NOT NULL DEFAULT '{}';

ALTER TABLE "virtual_agent" ADD CONSTRAINT "virtual_agent_local_only_ports_check" CHECK (
  cardinality("local_only_ports") <= 10
  AND 1024 <= ALL ("local_only_ports")
  AND 65535 >= ALL ("local_only_ports")
);

-- What the pod template is stamped with. Every `generation` bump moves it too, except a change of ports, which the
-- orchestrator applies to the Service and Ingress alone, so a server starting or stopping never restarts the pod.
ALTER TABLE "virtual_agent" ADD COLUMN "pod_generation" integer NOT NULL DEFAULT 1;

UPDATE "virtual_agent" SET "pod_generation" = "generation" WHERE "pod_generation" IS DISTINCT FROM "generation";
