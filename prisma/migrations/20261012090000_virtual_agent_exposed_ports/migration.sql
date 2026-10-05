-- The web ports the owner exposes, each at its own host through a Service and an Ingress the orchestrator applies.
-- The checks repeat src/virtual-agents/ports.ts, so no write can reach the orchestrator with a port it cannot serve.
ALTER TABLE "virtual_agent" ADD COLUMN "exposed_ports" integer[] NOT NULL DEFAULT '{}';

ALTER TABLE "virtual_agent" ADD CONSTRAINT "virtual_agent_exposed_ports_check" CHECK (
  cardinality("exposed_ports") <= 3
  AND 1024 <= ALL ("exposed_ports")
  AND 65535 >= ALL ("exposed_ports")
);
