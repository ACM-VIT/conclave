export type MediaToggleResult = { ok: boolean; error?: string };

type ResumableProducer = {
  resume: () => void;
  pause: () => void;
};

export const resumeProducerWithServerConfirmation = async (
  producer: ResumableProducer,
  confirmResume: () => Promise<MediaToggleResult>,
): Promise<MediaToggleResult> => {
  producer.resume();
  let result: MediaToggleResult;
  try {
    result = await confirmResume();
  } catch (error) {
    try {
      producer.pause();
    } catch {}
    throw error;
  }
  if (!result.ok) {
    try {
      producer.pause();
    } catch {}
  }
  return result;
};
