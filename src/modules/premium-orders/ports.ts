import type {
  CreatePremiumOrderInput,
  CreatePremiumOrderResult,
  PremiumFulfillmentResult,
  PremiumOrderView,
  PremiumPaymentEventInput,
  PremiumPaymentEventResult,
  RecordPremiumFulfillmentInput,
} from "./contracts.js";

export interface PremiumOrderRepository {
  createOrder(input: CreatePremiumOrderInput): Promise<CreatePremiumOrderResult>;
  applyPaymentEvent(input: PremiumPaymentEventInput): Promise<PremiumPaymentEventResult>;
  recordFulfillment(input: RecordPremiumFulfillmentInput): Promise<PremiumFulfillmentResult>;
  getOrder(orderId: string): Promise<PremiumOrderView | null>;
  listPlayerOrders(playerId: string): Promise<readonly PremiumOrderView[]>;
}
