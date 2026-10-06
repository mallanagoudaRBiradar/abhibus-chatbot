import { checkMessage } from '../src/shared/moderation';
const cases: [string, boolean][] = [
  ['When is the dinner stop?', true],
  ['call me 98765 43210', false],
  ['nine eight seven six five four three two one zero', false],
  ['my upi is ravi@okaxis', false],
  ['join t.me/busgroup', false],
  ['check abhibus dot com', false],
  ['insta: @night.rider', false],
  ['you are a ch00tiya', false],
  ['seat 12 to seat 14, 2 blankets please', true],
  ['Is there a whatsapp group?', true],
  ['reach by 5:30 am, 2 stops left', true],
];
let fail = 0;
for (const [text, expectOk] of cases) {
  const r = checkMessage(text);
  const pass = r.ok === expectOk;
  if (!pass) fail++;
  console.log(`${pass ? '✔' : '✖'} ${JSON.stringify(text)} -> ${r.ok ? 'allowed' : r.reason}`);
}
process.exit(fail ? 1 : 0);
