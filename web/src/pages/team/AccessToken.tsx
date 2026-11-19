import { Icon } from "@astryxdesign/core/Icon";
import { Token } from "@astryxdesign/core/Token";
import { Tooltip } from "@astryxdesign/core/Tooltip";
import { CommandLineIcon, EyeIcon, PencilSquareIcon } from "@heroicons/react/24/outline";
import type { Access } from "../../lib/types";
import { ACCESS_INFO, accessDescription } from "./team";

export const ACCESS_ICON = { read: EyeIcon, run: CommandLineIcon, write: PencilSquareIcon } as const;

/** An agent's access level as a token, with the tools it gets in repo tasks on hover. */
export function AccessToken({ access, size = "sm" }: { access: Access; size?: "sm" | "md" }) {
  const info = ACCESS_INFO[access];
  return (
    <Tooltip content={accessDescription(access)}>
      <Token label={info.label} color={info.color} size={size} icon={<Icon icon={ACCESS_ICON[access]} size="xsm" />} />
    </Tooltip>
  );
}
