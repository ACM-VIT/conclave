export const isConsumerPreferenceGenerationCurrent = ({
  enabled,
  socketConnected,
  updateConsumerClosed,
  updateConsumerId,
  currentConsumerId,
}: {
  enabled: boolean;
  socketConnected: boolean;
  updateConsumerClosed: boolean;
  updateConsumerId: string;
  currentConsumerId: string | null;
}): boolean =>
  enabled &&
  socketConnected &&
  !updateConsumerClosed &&
  currentConsumerId === updateConsumerId;

export const isConsumerGenerationDisplacedError = (error: string): boolean =>
  /consumer (?:generation )?displaced/i.test(error);
