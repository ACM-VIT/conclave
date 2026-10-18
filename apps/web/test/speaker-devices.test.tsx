import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DeviceSettingsSection } from "../src/app/components/DeviceCaretMenu";

describe("mobile speaker settings", () => {
  it("keeps the speaker and routing instructions visible before devices are exposed", () => {
    const html = renderToStaticMarkup(
      <DeviceSettingsSection active onAudioOutputDeviceChange={() => {}} />,
    );
    expect(html).toContain("Speaker");
    expect(html).toContain("System default speaker");
    expect(html).toContain("sound controls");
    expect(html).not.toContain("No microphones or speakers found");
  });
});
