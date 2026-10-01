'use strict';
const $ = (id) => document.getElementById(id);
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
let paused = reduced.matches;
function updateMotion() {
  document.body.classList.toggle('motion-paused', paused);
  $('motion-toggle').textContent = paused ? 'Play motion ▷' : 'Pause motion Ⅱ';
  $('motion-toggle').setAttribute('aria-pressed', String(paused));
}
$('motion-toggle').addEventListener('click', () => { paused = !paused; updateMotion(); });
reduced.addEventListener('change', () => { paused = reduced.matches; updateMotion(); });
updateMotion();
if (!reduced.matches && 'IntersectionObserver' in window) {
  document.body.classList.add('js-motion');
  const observer = new IntersectionObserver((entries) => entries.forEach((entry) => {
    if (entry.isIntersecting) { entry.target.classList.add('in-view'); observer.unobserve(entry.target); }
  }), { threshold: 0.08 });
  document.querySelectorAll('.project,.pipeline,.tool-grid,.principles,.start').forEach((element) => {
    element.classList.add('reveal'); observer.observe(element);
  });
}
// Display only. All monetary calculations are precomputed by the bundled Decimal engine.
let scenarios;
const decimal = (value, places = 3) => Number(value).toFixed(places);
const signed = (value) => (Number(value) > 0 ? '+' : '') + decimal(value);
function updateScenario() {
  if (!scenarios) return;
  const missing = $('missing-exit').checked;
  const cents = $('exit-price').value;
  $('exit-price').disabled = missing;
  $('exit-value').textContent = missing ? 'Unknown' : (Number(cents) / 100).toFixed(2);
  const result = scenarios.rows[`${$('fee-asset').value}:${$('slippage').value}:${missing ? 'missing' : cents}`];
  if (!result) { $('load-status').textContent = 'This scenario is unavailable. Try another selection.'; return; }
  $('pnl').textContent = missing ? `${signed(result.lowerPnl)} to ${signed(result.upperPnl)}` : signed(result.pnl);
  $('pnl').classList.toggle('negative', !missing && Number(result.pnl) < 0);
  $('pnl').classList.toggle('unknown', missing);
  $('pnl-label').textContent = missing ? 'Possible profit or loss range' : 'Profit or loss after fees';
  $('scenario-status').textContent = missing ? 'Sell price unknown' : 'Sell price set';
  $('pnl-detail').textContent = missing ? 'The range shows what your shares could be worth, from a zero payout to a full payout, minus cash spent.' : 'Cash received after the sell fee, minus cash spent.';
  for (const [id,key,places] of [['spent','spent',3],['gross-shares','grossShares',6],['net-shares','netShares',6],['buy-fee','buyFeeEquivalent',5],['residual','residualShares',9]]) $(id).textContent = decimal(result[key],places);
  $('sell-fee').textContent = result.sellFee === null ? 'Unknown' : decimal(result.sellFee,5);
  $('proceeds').textContent = result.proceeds === null ? 'Unknown' : decimal(result.proceeds);
  $('spent-bar').style.width = `${Number(result.spent)/16*100}%`;
  $('proceeds-bar').style.width = missing ? '0%' : `${Math.max(0,Math.min(100,Number(result.proceeds)/16*100))}%`;
  $('experiment-message').textContent = missing ? 'Set a selling price to calculate a specific result. Without one, a single profit figure would be misleading.' : $('fee-asset').value === 'shares' ? 'Share fees reduce what you can sell. They are not charged a second time as cash.' : 'Cash fees count against the same 10-unit budget. The model sizes down to stay within it.';
  $('load-status').textContent = 'Calculated by the plugin · values rounded for readability';
}
const controls = ['exit-price','fee-asset','slippage','missing-exit'];
controls.forEach((id) => { $(id).disabled = true; $(id).addEventListener('input', updateScenario); });
fetch(`scenarios.json?v=${encodeURIComponent(document.body.dataset.release)}`).then((r) => { if (!r.ok) throw new Error('Scenario data unavailable'); return r.json(); }).then((data) => {
  scenarios = data; controls.forEach((id) => { $(id).disabled = false; }); updateScenario();
}).catch(() => { $('load-status').textContent = 'Interactive data could not load. The displayed default is a fixed synthetic example. Download the tools to calculate locally.'; });
$('copy-command').addEventListener('click', async () => {
  try { await Promise.race([navigator.clipboard.writeText($('command-text').textContent), new Promise((_, reject) => setTimeout(() => reject(new Error('Clipboard unavailable')), 1500))]); $('copy-status').textContent = 'Example command copied.'; }
  catch { $('copy-status').textContent = 'Select the command above and copy it manually.'; }
});
