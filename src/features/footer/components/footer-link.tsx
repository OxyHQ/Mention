import Link from "next/link";

import { ILinkProps } from "../types/index";

import styles from "./styles/link.module.scss";

export const FooterLink = ({
  title = "loading",
  url = "#",
  target = "_blank",
}: ILinkProps) => {
  return (
    <Link
      href={url}
      rel="noopener noreferrer nofollow"
      target={target}
      className={styles.container}
    >
      {title}
    </Link>
  );
};
