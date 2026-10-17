import {
  CreatePremiumOrderInputSchema,
  PremiumPaymentEventInputSchema,
  RecordPremiumFulfillmentInputSchema,
} from "./contracts.js";
import type { PremiumOrderRepository } from "./ports.js";

export class PremiumOrderService {
  public constructor(private readonly repository: PremiumOrderRepository) {}

  public async createOrder(rawInput: unknown) {
    const input = CreatePremiumOrderInputSchema.parse(rawInput);
    return this.repository.createOrder(input);
  }

  public async applyPaymentEvent(rawInput: unknown) {
    const input = PremiumPaymentEventInputSchema.parse(rawInput);
    return this.repository.applyPaymentEvent(input);
  }

  public async recordFulfillment(rawInput: unknown) {
    const input = RecordPremiumFulfillmentInputSchema.parse(rawInput);
    return this.repository.recordFulfillment(input);
  }

  public async getOrder(orderId: string) {
    return this.repository.getOrder(orderId);
  }

  public async listPlayerOrders(playerId: string) {
    return this.repository.listPlayerOrders(playerId);
  }
}
