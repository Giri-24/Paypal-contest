/**
 * PayPal Smart Advisor & Escrow Guard Widget
 * 
 * Unslop-crafted add-on UI component for MINT:
 * - Real-time Escrow Guard telemetry & 72h honor period tracking
 * - Objective gateway comparison matrix (PayPal vs Card vs Wire)
 * - Contextual PayPal product recommendations
 * - Clean graphite surfaces, tabular numbers, zero emoji slop
 */

(function(window) {
  'use strict';

  function formatUSD(num) {
    const val = Number(num) || 0;
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2
    }).format(val);
  }

  function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[c]));
  }

  async function apiCall(url, method = 'GET', body = null) {
    const options = {
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (body) options.body = JSON.stringify(body);
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // ---------------------------------------------------------------------------
  // Milestone Advisor Widget
  // ---------------------------------------------------------------------------

  async function renderAdvisorWidget(dealId, milestoneIndex, element) {
    const container = typeof element === 'string' ? document.getElementById(element) : element;
    if (!container) return;

    container.innerHTML = `
      <div class="py-4 text-center text-xs text-slate-400 font-mono">
        <span class="inline-block w-3.5 h-3.5 border-2 border-mint-500/30 border-t-mint-400 rounded-full animate-spin mr-2 align-middle"></span>
        Querying PayPal Gateway Advisor telemetry...
      </div>
    `;

    try {
      const data = await apiCall(`/api/deals/${dealId}/milestones/${milestoneIndex}/advisor`);
      renderMilestoneAdvisorContent(container, dealId, milestoneIndex, data);
    } catch (err) {
      container.innerHTML = `
        <div class="p-3 bg-rose-500/10 border border-rose-500/20 rounded-xl text-xs text-rose-400">
          Failed to load advisor: ${esc(err.message)}
        </div>
      `;
    }
  }

  function renderMilestoneAdvisorContent(container, dealId, milestoneIndex, data) {
    const { escrowGuard, recommendations, comparison, milestoneAmount, milestoneStatus } = data;
    const isFunded = milestoneStatus === 'funded';

    let guardBadgeColor = 'text-slate-400 border-slate-700 bg-slate-800/40';
    if (escrowGuard.status === 'guaranteed') guardBadgeColor = 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10';
    if (escrowGuard.status === 'unguaranteed' || escrowGuard.status === 'expiring') guardBadgeColor = 'text-amber-400 border-amber-500/30 bg-amber-500/10';
    if (escrowGuard.status === 'expired') guardBadgeColor = 'text-rose-400 border-rose-500/30 bg-rose-500/10';

    container.innerHTML = `
      <div class="bg-navy-950/80 border border-navy-700 rounded-xl p-4 space-y-4 text-xs">
        <!-- Advisor Header & Segmented Tabs -->
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-navy-800 pb-3">
          <div class="flex items-center gap-2">
            <div class="w-6 h-6 rounded-lg bg-mint-500/10 border border-mint-500/25 flex items-center justify-center text-mint-400">
              <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg>
            </div>
            <div>
              <span class="font-semibold text-white">PayPal Gateway Advisor</span>
              <span class="text-slate-500 ml-2 font-mono">Milestone ${milestoneIndex + 1} (${formatUSD(milestoneAmount)})</span>
            </div>
          </div>

          <div class="inline-flex rounded-lg bg-navy-900 border border-navy-700/80 p-0.5" role="tablist">
            <button type="button" class="advisor-tab px-3 py-1 rounded-md text-[11px] font-medium text-mint-400 bg-navy-800 shadow transition" data-target="guard-${milestoneIndex}">
              Escrow Guard
            </button>
            <button type="button" class="advisor-tab px-3 py-1 rounded-md text-[11px] font-medium text-slate-400 hover:text-white transition" data-target="compare-${milestoneIndex}">
              Gateway Comparison
            </button>
            <button type="button" class="advisor-tab px-3 py-1 rounded-md text-[11px] font-medium text-slate-400 hover:text-white transition" data-target="recs-${milestoneIndex}">
              Products (${recommendations.length})
            </button>
          </div>
        </div>

        <!-- TAB 1: ESCROW GUARD TELEMETRY -->
        <div id="tab-guard-${milestoneIndex}" class="advisor-tab-panel space-y-3">
          <div class="bg-navy-900/90 border border-navy-800 rounded-xl p-3.5 space-y-3">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div class="flex items-center gap-2">
                <span class="px-2 py-0.5 rounded-full border text-[11px] font-medium ${guardBadgeColor}">
                  ● ${esc(escrowGuard.badge)}
                </span>
                ${escrowGuard.isGuaranteed ? `
                  <span class="font-mono text-emerald-400 text-[11px]">${escrowGuard.hoursRemaining}h honor period remaining</span>
                ` : ''}
                ${escrowGuard.status === 'unguaranteed' ? `
                  <span class="font-mono text-amber-400 text-[11px]">${escrowGuard.daysRemaining} days remaining in authorization</span>
                ` : ''}
              </div>

              ${escrowGuard.canReauthorize ? `
                <button type="button" onclick="window.paypalAdvisor.reauthorizeHold('${dealId}', ${milestoneIndex}, this)" class="bg-navy-800 border border-navy-700 hover:border-mint-500/50 text-white text-[11px] font-medium px-3 py-1.5 rounded-lg transition flex items-center gap-1.5">
                  <svg class="w-3 h-3 text-mint-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
                  <span>Reauthorize Hold</span>
                </button>
              ` : ''}
            </div>

            <p class="text-slate-300 leading-relaxed text-[11px]">${esc(escrowGuard.message)}</p>

            <!-- Dual-Stage Hold Longevity Gauge -->
            <div class="space-y-1">
              <div class="w-full bg-navy-950 h-1.5 rounded-full overflow-hidden border border-navy-800">
                <div class="h-full ${escrowGuard.isGuaranteed ? 'bg-emerald-400' : 'bg-amber-400'} rounded-full transition-all duration-300" style="width: ${isFunded ? (escrowGuard.isGuaranteed ? '35%' : '80%') : '0%'};"></div>
              </div>
              <div class="flex justify-between text-[10px] text-slate-500 font-mono">
                <span>0h (Hold Created)</span>
                <span class="${escrowGuard.isGuaranteed ? 'text-emerald-400' : 'text-slate-500'}">72h PayPal Honor Guarantee</span>
                <span>Day 29 (Max Validity)</span>
              </div>
            </div>
          </div>

          <!-- Specs Matrix -->
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
            <div class="bg-navy-900/60 border border-navy-800/80 rounded-lg p-2.5">
              <div class="text-slate-500 text-[10px]">Hold Protocol</div>
              <div class="font-mono text-white font-medium mt-0.5">AUTHORIZE</div>
            </div>
            <div class="bg-navy-900/60 border border-navy-800/80 rounded-lg p-2.5">
              <div class="text-slate-500 text-[10px]">Void Processing Fee</div>
              <div class="font-mono text-emerald-400 font-medium mt-0.5">$0.00 (Zero Fee)</div>
            </div>
            <div class="bg-navy-900/60 border border-navy-800/80 rounded-lg p-2.5">
              <div class="text-slate-500 text-[10px]">Partial Capture</div>
              <div class="font-mono text-white font-medium mt-0.5">Native Support</div>
            </div>
            <div class="bg-navy-900/60 border border-navy-800/80 rounded-lg p-2.5">
              <div class="text-slate-500 text-[10px]">AI Dispute Bridge</div>
              <div class="font-mono text-purple-400 font-medium mt-0.5">Gemini 2.0</div>
            </div>
          </div>
        </div>

        <!-- TAB 2: GATEWAY COMPARISON MATRIX -->
        <div id="tab-compare-${milestoneIndex}" class="advisor-tab-panel hidden space-y-3">
          <div class="overflow-x-auto border border-navy-800 rounded-xl bg-navy-900/60">
            <table class="w-full text-left border-collapse text-xs">
              <thead>
                <tr class="border-b border-navy-800 bg-navy-900 text-slate-400 text-[11px]">
                  <th class="py-2.5 px-3">Gateway Rail</th>
                  <th class="py-2.5 px-3 text-right">Escrow Score</th>
                  <th class="py-2.5 px-3 text-right">Est. Processing Fee</th>
                  <th class="py-2.5 px-3">Max Hold Window</th>
                  <th class="py-2.5 px-3">Partial Capture</th>
                  <th class="py-2.5 px-3">Payout Velocity</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-navy-800/60">
                ${comparison.gateways.map(g => {
                  const isPP = g.id === 'paypal';
                  return `
                    <tr class="${isPP ? 'bg-mint-500/5' : ''}">
                      <td class="py-2.5 px-3">
                        <div class="flex items-center gap-2">
                          <span class="font-mono text-[10px] text-slate-500">#${g.rank}</span>
                          <div>
                            <div class="font-semibold ${isPP ? 'text-mint-400' : 'text-white'}">${esc(g.name)}</div>
                            <div class="text-[10px] text-slate-400 max-w-xs">${esc(g.summary)}</div>
                          </div>
                        </div>
                      </td>
                      <td class="py-2.5 px-3 text-right font-mono font-bold ${isPP ? 'text-emerald-400' : 'text-slate-300'}">
                        ${g.score}/100
                      </td>
                      <td class="py-2.5 px-3 text-right">
                        <div class="font-mono font-semibold text-white">${formatUSD(g.estimatedFee)}</div>
                        <div class="font-mono text-[10px] text-slate-500">${esc(g.feeCalculation)}</div>
                      </td>
                      <td class="py-2.5 px-3 font-mono text-slate-300">${esc(g.holdDuration)}</td>
                      <td class="py-2.5 px-3 font-mono ${g.features.partialCapture ? 'text-emerald-400' : 'text-slate-500'}">
                        ${g.features.partialCapture ? 'Supported' : 'Unavailable'}
                      </td>
                      <td class="py-2.5 px-3 font-mono text-slate-300">${esc(g.payoutSpeed)}</td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>

          <!-- Honest Trade-Off Box -->
          <div class="bg-navy-900/90 border-l-2 border-mint-500 border-r border-t border-b border-navy-800 rounded-xl p-3">
            <div class="font-mono text-[10px] uppercase text-mint-400 font-semibold mb-1">Objective Trade-Off Audit</div>
            <p class="text-[11px] text-slate-300 leading-relaxed">${esc(comparison.tradeOffNote)}</p>
          </div>
        </div>

        <!-- TAB 3: SMART PRODUCT RECOMMENDATIONS -->
        <div id="tab-recs-${milestoneIndex}" class="advisor-tab-panel hidden space-y-3">
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            ${recommendations.map(p => `
              <div class="bg-navy-900/90 border ${p.fit === 'essential' ? 'border-mint-500/30' : 'border-navy-800'} rounded-xl p-3 space-y-2">
                <div class="flex items-start justify-between gap-2">
                  <div>
                    <div class="text-[10px] text-slate-500 font-mono">${esc(p.category)}</div>
                    <div class="font-semibold text-white text-xs mt-0.5">${esc(p.name)}</div>
                  </div>
                  <span class="text-[10px] px-2 py-0.5 rounded-full ${p.fit === 'essential' ? 'bg-mint-500/20 text-mint-300 border border-mint-500/40' : 'bg-navy-800 text-slate-400'} font-medium">
                    ${esc(p.badge)}
                  </span>
                </div>
                <p class="text-[11px] text-slate-300 leading-relaxed">${esc(p.description)}</p>
                <div class="pt-2 border-t border-navy-800 space-y-1">
                  ${p.benefits.map(b => `
                    <div class="text-[10px] text-slate-400 flex items-center gap-1.5">
                      <span class="w-1 h-1 rounded-full bg-mint-400"></span>
                      <span>${esc(b)}</span>
                    </div>
                  `).join('')}
                </div>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    `;

    // Bind tab clicks
    container.querySelectorAll('.advisor-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        container.querySelectorAll('.advisor-tab').forEach(t => {
          t.classList.remove('text-mint-400', 'bg-navy-800', 'shadow');
          t.classList.add('text-slate-400');
        });
        tab.classList.remove('text-slate-400');
        tab.classList.add('text-mint-400', 'bg-navy-800', 'shadow');

        const target = tab.dataset.target;
        container.querySelectorAll('.advisor-tab-panel').forEach(p => p.classList.add('hidden'));
        const activePanel = container.querySelector(`#tab-${target}`);
        if (activePanel) activePanel.classList.remove('hidden');
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Dashboard Command Center Advisor
  // ---------------------------------------------------------------------------

  async function renderDashboardAdvisor(element) {
    const container = typeof element === 'string' ? document.getElementById(element) : element;
    if (!container) return;

    try {
      const data = await apiCall('/api/advisor/dashboard');
      renderDashboardAdvisorContent(container, data);
    } catch (err) {
      console.warn('Dashboard advisor load error:', err.message);
    }
  }

  function renderDashboardAdvisorContent(container, data) {
    const { totalEscrowHeld, activeHoldsCount, guaranteedCount, unguaranteedCount, expiringCount, holdsList, benchmarkComparison, productHighlights } = data;

    container.innerHTML = `
      <div class="px-6 py-4 border-b border-navy-700 flex flex-wrap items-center justify-between gap-3 bg-navy-900/40">
        <div class="flex items-center gap-2.5">
          <div class="w-7 h-7 rounded-lg bg-mint-500/10 border border-mint-500/30 flex items-center justify-center text-mint-400">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg>
          </div>
          <div>
            <h3 class="font-semibold text-white text-sm">PayPal Smart Advisor & Escrow Guard Command Center</h3>
            <p class="text-[11px] text-slate-400">Real-time authorization hold telemetry, gateway benchmarking & product suggestions</p>
          </div>
        </div>
        <div class="flex items-center gap-3">
          <span class="text-xs px-2.5 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 font-mono font-medium">
            PayPal Score: 96/100
          </span>
        </div>
      </div>

      <div class="p-6 space-y-6">
        <!-- Telemetry Summary Cards -->
        <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <div class="bg-navy-900/70 border border-navy-800 rounded-xl p-4">
            <span class="text-[10px] font-medium text-slate-400 uppercase tracking-wider">Active Escrow Holds</span>
            <div class="mt-1 text-2xl font-bold font-mono text-white">${activeHoldsCount}</div>
            <div class="text-[11px] text-slate-400 font-mono mt-0.5">${formatUSD(totalEscrowHeld)} held on PayPal</div>
          </div>

          <div class="bg-navy-900/70 border border-emerald-500/20 rounded-xl p-4">
            <span class="text-[10px] font-medium text-emerald-400 uppercase tracking-wider">72h Guaranteed Holds</span>
            <div class="mt-1 text-2xl font-bold font-mono text-emerald-400">${guaranteedCount}</div>
            <div class="text-[11px] text-slate-400 mt-0.5">100% honor period backed</div>
          </div>

          <div class="bg-navy-900/70 border border-amber-500/20 rounded-xl p-4">
            <span class="text-[10px] font-medium text-amber-400 uppercase tracking-wider">Unguaranteed Holds</span>
            <div class="mt-1 text-2xl font-bold font-mono text-amber-400">${unguaranteedCount}</div>
            <div class="text-[11px] text-slate-400 mt-0.5">Eligible for reauthorization</div>
          </div>

          <div class="bg-navy-900/70 border border-rose-500/20 rounded-xl p-4">
            <span class="text-[10px] font-medium text-rose-400 uppercase tracking-wider">Expiring Soon</span>
            <div class="mt-1 text-2xl font-bold font-mono text-rose-400">${expiringCount}</div>
            <div class="text-[11px] text-slate-400 mt-0.5">&ge; 28 days of 29-day limit</div>
          </div>
        </div>

        <!-- Gateway Comparison & Product Highlights Side by Side -->
        <div class="grid grid-cols-1 xl:grid-cols-2 gap-6">
          <!-- Gateway Comparison Table -->
          <div class="bg-navy-900/60 border border-navy-800 rounded-xl p-4 space-y-3">
            <div class="flex items-center justify-between">
              <h4 class="text-xs font-semibold uppercase tracking-wider text-slate-300">Gateway Benchmark ($15,000 Milestone)</h4>
              <span class="text-[10px] text-mint-400 font-mono">Escrow Scoring</span>
            </div>

            <div class="overflow-x-auto">
              <table class="w-full text-left text-xs border-collapse">
                <thead>
                  <tr class="border-b border-navy-800 text-slate-400 text-[10px]">
                    <th class="py-2">Rail</th>
                    <th class="py-2 text-right">Score</th>
                    <th class="py-2 text-right">Est. Fee</th>
                    <th class="py-2">Hold Limit</th>
                    <th class="py-2">Partial Cap</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-navy-800/40">
                  ${benchmarkComparison.gateways.map(g => `
                    <tr class="${g.id === 'paypal' ? 'text-mint-300' : 'text-slate-300'}">
                      <td class="py-2 font-medium">${esc(g.name.split(' ')[0])}</td>
                      <td class="py-2 text-right font-mono font-bold ${g.id === 'paypal' ? 'text-emerald-400' : 'text-slate-400'}">${g.score}</td>
                      <td class="py-2 text-right font-mono">${formatUSD(g.estimatedFee)}</td>
                      <td class="py-2 font-mono text-[11px]">${esc(g.holdDuration.split(' ')[0])} Days</td>
                      <td class="py-2 font-mono text-[11px] ${g.features.partialCapture ? 'text-emerald-400' : 'text-slate-500'}">
                        ${g.features.partialCapture ? '✓' : '✗'}
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>

            <div class="text-[11px] text-slate-400 border-t border-navy-800 pt-2 leading-relaxed">
              <strong class="text-white">Honest Audit:</strong> ${esc(benchmarkComparison.tradeOffNote)}
            </div>
          </div>

          <!-- Active Escrow Holds List with Quick Reauthorization -->
          <div class="bg-navy-900/60 border border-navy-800 rounded-xl p-4 space-y-3">
            <div class="flex items-center justify-between">
              <h4 class="text-xs font-semibold uppercase tracking-wider text-slate-300">Active Authorized Holds</h4>
              <span class="text-[10px] text-slate-400 font-mono">${holdsList.length} Active</span>
            </div>

            <div class="space-y-2 max-h-[220px] overflow-y-auto">
              ${holdsList.length ? holdsList.map(h => `
                <div class="bg-navy-950/70 border border-navy-800/80 rounded-lg p-2.5 flex items-center justify-between gap-3">
                  <div>
                    <div class="text-xs font-semibold text-white">${esc(h.dealTitle)}</div>
                    <div class="text-[10px] text-slate-400 font-mono">${esc(h.milestoneTitle)} · ${formatUSD(h.amount)}</div>
                  </div>
                  <div class="flex items-center gap-2">
                    <span class="text-[10px] px-2 py-0.5 rounded-full border font-mono ${
                      h.escrowGuard.status === 'guaranteed' ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10' :
                      h.escrowGuard.status === 'unguaranteed' ? 'text-amber-400 border-amber-500/30 bg-amber-500/10' :
                      'text-rose-400 border-rose-500/30 bg-rose-500/10'
                    }">
                      ${esc(h.escrowGuard.badge)}
                    </span>
                    ${h.escrowGuard.canReauthorize ? `
                      <button type="button" onclick="window.paypalAdvisor.reauthorizeHold('${h.dealId}', ${h.milestoneIndex}, this)" class="text-[10px] bg-navy-800 hover:bg-navy-700 text-white px-2 py-1 rounded transition">
                        Reauth
                      </button>
                    ` : ''}
                  </div>
                </div>
              `).join('') : `
                <div class="py-8 text-center text-xs text-slate-500">
                  No active PayPal authorization holds yet. Fund a milestone to activate Escrow Guard.
                </div>
              `}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // Action: Reauthorize Hold
  async function reauthorizeHold(dealId, milestoneIndex, btn) {
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = 'Renewing...';
    }

    try {
      const res = await apiCall(`/api/deals/${dealId}/milestones/${milestoneIndex}/reauthorize`, 'POST');
      if (typeof window.showToast === 'function') {
        window.showToast('PayPal authorization hold reauthorized! 3-day guarantee renewed.');
      } else {
        alert('PayPal authorization hold reauthorized! 3-day guarantee renewed.');
      }

      // Refresh deal workspace if open
      if (typeof window.loadDealWorkspace === 'function' && window.state?.activeDealId === dealId) {
        await window.loadDealWorkspace(dealId);
      }
      // Refresh dashboard if open
      if (typeof window.refreshData === 'function') {
        await window.refreshData();
      }
      renderDashboardAdvisor('dashboard-advisor-section');
    } catch (err) {
      alert(`Reauthorization failed: ${err.message}`);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = 'Reauthorize Hold';
      }
    }
  }

  // Toggle Advisor slot in milestone view
  function toggleAdvisor(dealId, milestoneIndex) {
    const slot = document.getElementById(`advisor-slot-${milestoneIndex}`);
    if (!slot) return;
    if (slot.classList.contains('hidden')) {
      slot.classList.remove('hidden');
      renderAdvisorWidget(dealId, milestoneIndex, slot);
    } else {
      slot.classList.add('hidden');
    }
  }

  // Export to global scope
  window.paypalAdvisor = {
    renderAdvisorWidget,
    renderDashboardAdvisor,
    reauthorizeHold,
    toggleAdvisor
  };

})(window);
