import { describe, expect, it } from "vitest";

import { replayTick, type ReplayInput } from "../../apps/worker/src/tools/replayTick";

const baseRow = {
  walletId: 1,
  stateId: 1,
  edgeLcbBps: 10,
  edgeUcbBps: 20,
  pFillLcb: 0.7,
  reasonDetail: null
};

describe("replayTick golden behavior snapshots", () => {
  it("keeps deterministic taker ranking and gating outcomes", () => {
    const input: ReplayInput = {
      env: "paper",
      regimeRows: [
        {
          ...baseRow,
          kind: "TAKER_BUY",
          stateId: 1,
          allowed: true,
          mode: "full",
          sizeMultiplier: 1,
          reasonCode: "ok",
          scoreBps: 30
        },
        {
          ...baseRow,
          kind: "TAKER_BUY",
          stateId: 2,
          allowed: true,
          mode: "explore",
          sizeMultiplier: 0.5,
          reasonCode: "sparse_explore",
          scoreBps: 15
        },
        {
          ...baseRow,
          kind: "TAKER_SELL",
          stateId: 1,
          allowed: false,
          mode: "blocked",
          sizeMultiplier: 0,
          reasonCode: "explicit_block",
          scoreBps: -10
        }
      ],
      taker: {
        feed: {
          ageSec: 1,
          freshnessThresholdSec: 20
        },
        opportunities: [
          {
            marketId: "m-a",
            tokenId: "t-a",
            walletId: 1,
            stateId: 1,
            signal: "BUY",
            confidence: 0.9,
            netEdgeBps: 12
          },
          {
            marketId: "m-b",
            tokenId: "t-b",
            walletId: 1,
            stateId: 2,
            signal: "BUY",
            confidence: 0.8,
            netEdgeBps: 25
          },
          {
            marketId: "m-c",
            tokenId: "t-c",
            walletId: 1,
            stateId: 1,
            signal: "SELL",
            confidence: 0.8,
            netEdgeBps: 40
          }
        ]
      }
    };

    const out = replayTick(input, 1_700_000_000_000);
    expect({
      ranked: out.takerTrace?.ranked,
      counts: out.takerTrace?.candidates,
      top: out.takerTrace?.topDecisions.map((d) => ({
        tokenId: d.tokenId,
        kind: d.kind,
        mode: d.mode,
        reasonCode: d.reasonCode,
        filteredBy: d.filteredBy
      })),
      outcome: out.takerTrace?.outcome
    }).toMatchInlineSnapshot(`
      {
        "counts": {
          "afterRegime": 2,
          "afterRisk": 2,
          "afterSideFilters": 3,
          "afterWalletEligibility": 3,
          "generated": 3,
        },
        "outcome": {
          "placedOrders": 2,
          "whyIdle": null,
        },
        "ranked": [
          {
            "kind": "TAKER_BUY",
            "score": 30,
            "tokenId": "t-a",
          },
          {
            "kind": "TAKER_BUY",
            "score": 15,
            "tokenId": "t-b",
          },
        ],
        "top": [
          {
            "filteredBy": null,
            "kind": "TAKER_BUY",
            "mode": "full",
            "reasonCode": "ok",
            "tokenId": "t-a",
          },
          {
            "filteredBy": null,
            "kind": "TAKER_BUY",
            "mode": "explore",
            "reasonCode": "sparse_explore",
            "tokenId": "t-b",
          },
          {
            "filteredBy": "explicit_block",
            "kind": "TAKER_SELL",
            "mode": "blocked",
            "reasonCode": "explicit_block",
            "tokenId": "t-c",
          },
        ],
      }
    `);
  });

  it("keeps deterministic maker side keep/drop outcomes", () => {
    const input: ReplayInput = {
      env: "paper",
      regimeRows: [
        {
          ...baseRow,
          kind: "MAKER_BID",
          stateId: 10,
          allowed: true,
          mode: "full",
          sizeMultiplier: 1,
          reasonCode: "ok",
          scoreBps: 22
        },
        {
          ...baseRow,
          kind: "MAKER_ASK",
          stateId: 10,
          allowed: false,
          mode: "blocked",
          sizeMultiplier: 0,
          reasonCode: "explicit_block",
          scoreBps: -5
        },
        {
          ...baseRow,
          kind: "MAKER_BID",
          stateId: 11,
          allowed: true,
          mode: "explore",
          sizeMultiplier: 0.4,
          reasonCode: "sparse_explore",
          scoreBps: 9
        }
      ],
      maker: {
        feed: {
          ageSec: 1,
          freshnessThresholdSec: 20
        },
        candidates: [
          {
            marketId: "m-x",
            tokenId: "t-x",
            walletId: 1,
            stateId: 10,
            hasBid: true,
            hasAsk: true
          },
          {
            marketId: "m-y",
            tokenId: "t-y",
            walletId: 1,
            stateId: 11,
            hasBid: true,
            hasAsk: false
          }
        ]
      }
    };

    const out = replayTick(input, 1_700_000_000_000);
    expect({
      counts: out.makerTrace?.candidates,
      top: out.makerTrace?.topDecisions.map((d) => ({
        tokenId: d.tokenId,
        kind: d.kind,
        mode: d.mode,
        sizeMultiplier: d.sizeMultiplier,
        filteredBy: d.filteredBy
      })),
      outcome: out.makerTrace?.outcome
    }).toMatchInlineSnapshot(`
      {
        "counts": {
          "afterRegime": 2,
          "afterRisk": 3,
          "afterSideFilters": 3,
          "afterWalletEligibility": 2,
          "generated": 3,
        },
        "outcome": {
          "placedOrders": 2,
          "whyIdle": null,
        },
        "top": [
          {
            "filteredBy": null,
            "kind": "MAKER_BID",
            "mode": "full",
            "sizeMultiplier": 1,
            "tokenId": "t-x",
          },
          {
            "filteredBy": "explicit_block",
            "kind": "MAKER_ASK",
            "mode": "blocked",
            "sizeMultiplier": 0,
            "tokenId": "t-x",
          },
          {
            "filteredBy": null,
            "kind": "MAKER_BID",
            "mode": "explore",
            "sizeMultiplier": 0.4,
            "tokenId": "t-y",
          },
        ],
      }
    `);
  });

  it("keeps regime-load idle outcomes stable for not-loaded/last-good/blocked scenarios", () => {
    const baseInput: ReplayInput = {
      env: "paper",
      regimeRows: [
        {
          ...baseRow,
          kind: "TAKER_BUY",
          stateId: 3,
          allowed: false,
          mode: "blocked",
          sizeMultiplier: 0,
          reasonCode: "explicit_block",
          scoreBps: -3
        }
      ],
      taker: {
        feed: {
          ageSec: 1,
          freshnessThresholdSec: 20
        },
        opportunities: [
          {
            marketId: "m-z",
            tokenId: "t-z",
            walletId: 1,
            stateId: 3,
            signal: "BUY",
            confidence: 0.7,
            netEdgeBps: 5
          }
        ]
      }
    };

    const snapshots = [
      {
        label: "not_loaded_no_last_good",
        out: replayTick(
          {
            ...baseInput,
            regimeLoad: {
              reasonCode: "not_loaded_no_last_good",
              usedLastGood: false
            }
          },
          1_700_000_000_000
        )
      },
      {
        label: "using_last_good_blocked",
        out: replayTick(
          {
            ...baseInput,
            regimeLoad: {
              reasonCode: "using_last_good",
              usedLastGood: true
            }
          },
          1_700_000_000_000
        )
      },
      {
        label: "using_last_good_allowed",
        out: replayTick(
          {
            ...baseInput,
            regimeRows: [
              {
                ...baseRow,
                kind: "TAKER_BUY",
                stateId: 3,
                allowed: true,
                mode: "full",
                sizeMultiplier: 1,
                reasonCode: "ok",
                scoreBps: 8
              }
            ],
            regimeLoad: {
              reasonCode: "using_last_good",
              usedLastGood: true
            }
          },
          1_700_000_000_000
        )
      }
    ].map((entry) => ({
      label: entry.label,
      placedOrders: entry.out.takerTrace?.outcome.placedOrders,
      whyIdle: entry.out.takerTrace?.outcome.whyIdle
    }));

    expect(snapshots).toMatchInlineSnapshot(`
      [
        {
          "label": "not_loaded_no_last_good",
          "placedOrders": 0,
          "whyIdle": {
            "code": "regime_not_loaded_no_last_good",
            "detail": "explicit_block:1",
          },
        },
        {
          "label": "using_last_good_blocked",
          "placedOrders": 0,
          "whyIdle": {
            "code": "all_filtered_regime_blocked",
            "detail": "explicit_block:1",
          },
        },
        {
          "label": "using_last_good_allowed",
          "placedOrders": 1,
          "whyIdle": null,
        },
      ]
    `);
  });
});
