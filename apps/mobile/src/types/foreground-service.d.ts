declare module "@supersami/rn-foreground-service" {
  type ForegroundServiceOptions = {
    id: number;
    title: string;
    message: string;
    importance?: "low" | "default" | "high" | "min" | "max";
    visibility?: "public" | "private" | "secret";
    vibration?: boolean;
    icon?: string;
  };

  const ForegroundService: {
    start: (options: ForegroundServiceOptions) => Promise<void>;
    stop?: () => Promise<void>;
    stopAll?: () => Promise<void>;
  };

  export default ForegroundService;
}
