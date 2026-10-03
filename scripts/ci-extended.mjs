import { runDockerJob } from "./lib/docker-job.mjs";

await runDockerJob("ci:extended");
