import type * as React from "react";
import type { Drawer as DrawerPrimitive } from "vaul";

export type DrawerContentProps = React.ComponentProps<typeof DrawerPrimitive.Content> & {
  showHandle?: boolean;
};
