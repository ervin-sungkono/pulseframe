import { Slot } from "radix-ui";

import { cn } from "@/lib/utils";
import { buttonVariants } from "./const";
import type { ButtonProps } from "./type";

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button };
export type { ButtonProps } from "./type";
