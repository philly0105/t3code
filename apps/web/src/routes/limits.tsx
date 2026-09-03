import { createFileRoute } from "@tanstack/react-router";

import { LimitsPage } from "../components/limits/LimitsPage";

export const Route = createFileRoute("/limits")({
  component: LimitsPage,
});
