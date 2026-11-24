import { key, table, type TableKey } from "@conclave/apps-sdk/authority/server";

export type ActionOrder = { last: number };

export const ACTION_ORDER_TABLE = "order";

const COUNTER = key("last");

type OrderTransaction = {
  get(table: typeof ACTION_ORDER_TABLE, key: TableKey): Readonly<ActionOrder> | undefined;
  put(table: typeof ACTION_ORDER_TABLE, key: TableKey, row: ActionOrder): void;
};

export const actionOrderTable = () => table<ActionOrder>({ maxRows: 1 });

export const nextActionOrder = (tx: OrderTransaction): number => {
  const order = (tx.get(ACTION_ORDER_TABLE, COUNTER)?.last ?? 0) + 1;
  tx.put(ACTION_ORDER_TABLE, COUNTER, { last: order });
  return order;
};
