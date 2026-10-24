import type * as React from "react";
import type { AlertDialog as AlertDialogPrimitive } from "radix-ui";
import type { ButtonProps } from "@/components/ui/Button";

export type AlertDialogContentProps = React.ComponentProps<typeof AlertDialogPrimitive.Content> & {
  size?: "default" | "sm";
};

export type AlertDialogCancelProps = React.ComponentProps<typeof AlertDialogPrimitive.Cancel> &
  Partial<Pick<ButtonProps, "variant" | "size">>;
