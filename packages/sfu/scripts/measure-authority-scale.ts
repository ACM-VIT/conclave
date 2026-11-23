/**
 * Prints the runtime's own cost at the design's target load.
 *
 *   pnpm -C packages/sfu exec tsx scripts/measure-authority-scale.ts [people]
 */
import { measureAuthorityScale } from "../test/authority/scale.js";

const people = Number(process.argv[2] ?? 50);
const realNow = Date.now.bind(Date);
let offset = 0;
Date.now = () => realNow() + offset;

const report = measureAuthorityScale(
  people,
  (ms) => {
    offset += ms;
  },
  { flushManually: true },
);
const total = report.actCpuMsPerSecond + report.flushCpuMsPerSecond;

console.log(`people in the room:             ${report.people}`);
console.log(`questions on the board:         ${report.questions}`);
console.log(
  `actions offered per second:     ${report.offeredPerSecond} (accepted ${report.acceptedPerSecond.toFixed(1)}, rate-limited ${report.limitedPerSecond.toFixed(1)})`,
);
console.log(`flushes per second:             ${report.flushesPerSecond}`);
console.log(`CPU in actions:                 ${report.actCpuMsPerSecond.toFixed(1)} ms per second`);
console.log(`CPU in flushes:                 ${report.flushCpuMsPerSecond.toFixed(1)} ms per second`);
console.log(`runtime total:                  ${(total / 10).toFixed(2)}% of one core`);
console.log(`shared projections:             ${report.sharedProjections}`);
console.log(`frames per second:              ${report.framesPerSecond.toFixed(1)}`);
console.log(`busiest recipient, frames/s:    ${report.maxFramesPerRecipientPerSecond.toFixed(1)}`);
console.log(`bytes per person per second:    ${(report.bytesPerPersonPerSecond / 1024).toFixed(2)} KB`);
console.log(`misdelivered personal rows:     ${report.misdeliveredPersonalRows}`);
