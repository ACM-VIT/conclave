import { useEffect, useRef, useState } from "react";

interface UseMeetLifecycleOptions {
  cleanup: () => void;
  abortControllerRef: React.MutableRefObject<AbortController | null>;
}

export function useMeetLifecycle({
  cleanup,
  abortControllerRef,
}: UseMeetLifecycleOptions) {
  const [mounted, setMounted] = useState(false);
  const cleanupRef = useRef(cleanup);

  useEffect(() => {
    cleanupRef.current = cleanup;
  }, [cleanup]);

  useEffect(() => {
    setMounted(true);
    abortControllerRef.current = new AbortController();

    return () => {
      abortControllerRef.current?.abort();
      cleanupRef.current();
    };
  }, [abortControllerRef]);

  return {
    mounted,
  };
}
