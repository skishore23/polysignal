import { describe, expect, it, vi } from "vitest";
import { LiveExecutionGateway } from "../../apps/worker/src/execution/clobExecution";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn()
} as any;

const makeGateway = () =>
  new LiveExecutionGateway(
    {
      enabled: true,
      host: "https://clob.polymarket.com",
      chainId: 137,
      privateKey: "0xabc",
      apiKey: "k",
      apiSecret: "s",
      apiPassphrase: "p",
      signatureType: 0,
      funder: null
    },
    { logger }
  );

describe("LiveExecutionGateway maker post-only + batch posting", () => {
  it("submits maker orders as post-only", async () => {
    const gateway = makeGateway() as any;
    const createAndPostOrder = vi.fn(async () => ({
      orderID: "ord-1",
      status: "OPEN",
      size_matched: "0",
      price: "0.5"
    }));
    gateway.ready = true;
    gateway.client = { createAndPostOrder };
    gateway.getOrderMeta = vi.fn(async () => ({
      tickSize: 0.01,
      negRisk: false,
      minOrderSize: 1,
      feeRateBps: 2500
    }));

    const result = await gateway.placeMakerOrder({
      walletId: 1,
      tokenId: "t1",
      side: "BUY",
      price: 0.5,
      size: 10,
      kind: "MAKER_BID",
      reason: "test"
    });

    expect(result).not.toBeNull();
    expect(createAndPostOrder).toHaveBeenCalledTimes(1);
    expect(createAndPostOrder.mock.calls[0][2]).toBeDefined();
    expect(createAndPostOrder.mock.calls[0][3]).toBe(true);
  });

  it("uses postOrders for batch placement instead of looping singles", async () => {
    const gateway = makeGateway() as any;
    const createOrder = vi.fn(async (payload: unknown) => ({ signed: true, payload }));
    const postOrders = vi.fn(async (orders: unknown[]) =>
      orders.map((_, idx) => ({
        orderID: `ord-${idx + 1}`,
        status: "OPEN",
        size_matched: "0",
        price: "0.5"
      }))
    );
    gateway.ready = true;
    gateway.client = { createOrder, postOrders };
    gateway.getOrderMeta = vi.fn(async () => ({
      tickSize: 0.01,
      negRisk: false,
      minOrderSize: 1,
      feeRateBps: 2500
    }));

    const results = await gateway.batchPlaceOrders([
      {
        walletId: 1,
        tokenId: "t1",
        side: "BUY",
        price: 0.5,
        size: 10,
        kind: "TAKER_BUY",
        reason: "test",
        postOnly: false
      },
      {
        walletId: 1,
        tokenId: "t2",
        side: "SELL",
        price: 0.5,
        size: 10,
        kind: "TAKER_SELL",
        reason: "test",
        postOnly: false
      }
    ]);

    expect(results).toHaveLength(2);
    expect(createOrder).toHaveBeenCalledTimes(2);
    expect(postOrders).toHaveBeenCalledTimes(1);
  });
});
