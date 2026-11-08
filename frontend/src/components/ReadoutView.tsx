import { PanelView } from "./PanelView";
import type { ReadoutPackage } from "../lib/readout";
import type { CommandRunner } from "../lib/deviceFileTransfer";

/**
 * A readout is a panel without actions: the same view draws both, and
 * PanelView refuses a readout that declares any (panelRejectionReason).
 */
export type ReadoutViewProps = {
  pkg: ReadoutPackage;
  /** Injected so this shares whatever single-flight mutex the host page owns. */
  runner: CommandRunner;
  busy?: boolean;
};

export function ReadoutView({ pkg, runner, busy = false }: ReadoutViewProps) {
  return <PanelView pkg={pkg} runner={runner} busy={busy} />;
}
