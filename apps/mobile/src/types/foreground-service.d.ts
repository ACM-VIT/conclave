declare module "@supersami/rn-foreground-service" {
  type ForegroundServiceOptions = {
    id: number;
    title: string;
    message: string;
    ServiceType?: string;
    importance?: "low" | "default" | "high" | "min" | "max";
    visibility?: "public" | "private" | "secret";
    vibration?: boolean;
    icon?: string;
    largeIcon?: string;
    color?: string;
    button?: boolean;
    buttonText?: string;
    buttonOnPress?: string;
    button2?: boolean;
    button2Text?: string;
    button2OnPress?: string;
    mainOnPress?: string;
  };

  const ForegroundService: {
    start: (options: ForegroundServiceOptions) => Promise<void>;
    update?: (options: ForegroundServiceOptions) => Promise<void>;
    stop?: () => Promise<void>;
    stopAll?: () => Promise<void>;
    eventListener?: (callback: (event: Record<string, string>) => void) => () => void;
  };

  export default ForegroundService;
}
