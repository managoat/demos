/**
 * The machine's temperature, as a dot and as a chip.
 *
 * One reading, two shapes, because a project appears in three places and the
 * answer must not differ between them. The rail and the recent list get the
 * dot; the crumbs above a track get the chip, with the word spelled out —
 * that is the one place somebody is about to type, and "cold" next to the
 * composer is the difference between waiting a minute and thinking the app
 * has hung.
 *
 * The wording is about *their* next action rather than about the box. "The
 * machine is suspended" is Fountain's fact; "the next turn wakes it, which
 * takes a minute" is the same fact answering the question they have.
 */
import type { MachineHeat, Project } from "../../shared/api";

interface Reading {
  heat: MachineHeat;
  label: string;
  why: string;
}

export function readHeat(machine: Project["machine"]): Reading {
  switch (machine.heat) {
    case "active":
      return { heat: "active", label: "active", why: "A turn is running on this machine. What you send queues behind it." };
    case "warm":
      return { heat: "warm", label: "warm", why: "The machine is up and idle. The next turn starts straight away." };
    default:
      return {
        heat: "cold",
        // The one distinction heat itself does not carry — see `MachineHeat`
        // in shared/api.ts. Both are cold; only one of them has a disk.
        label: machine.status === "none" ? "no machine" : "cold",
        why:
          machine.status === "none"
            ? "No machine yet. The first track you open builds one."
            : "The machine is asleep. The next turn wakes it, which takes a minute.",
      };
  }
}

export function MachineDot({ machine }: { machine: Project["machine"] }) {
  const { heat, label, why } = readHeat(machine);
  return <span className={`dot ${heat}`} title={`Machine ${label} — ${why}`} aria-label={`Machine ${label}`} />;
}

export function MachineChip({ machine }: { machine: Project["machine"] }) {
  const { heat, label, why } = readHeat(machine);
  return (
    <span className={`chip heat ${heat}`} title={why}>
      <span className={`dot ${heat}`} aria-hidden="true" />
      {label}
    </span>
  );
}
