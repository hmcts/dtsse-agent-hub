-- How much CPU and memory a virtual agent's pod asks for. Existing agents keep the resources they were made with.
CREATE TYPE "virtual_agent_size" AS ENUM ('small', 'medium', 'large');

ALTER TABLE "virtual_agent" ADD COLUMN "size" "virtual_agent_size" NOT NULL DEFAULT 'small';
