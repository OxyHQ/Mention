import Link from "next/link";

import { VerifiedIcon } from "@/assets/verified-icon";
import { EllipsisWrapper } from "@/components/elements/ellipsis-wrapper";
import { HamburgerButton } from "@/components/elements/hamburger-button";
import { ColorPicker } from "@/features/color-picker";
import { FontSizeCustomization } from "@/features/font-size-customization";
import { Header } from "@/features/header";
import { Avatar } from "@/features/profile";
import { ThemePicker } from "@/features/themes";

import LanguageSwitcher from "@/app/LanguageSwitcher";

import styles from "./styles/settings.module.scss";

const Settings = () => {
  return (
    <div className={styles.container}>
      <Header>
        <HamburgerButton />
        <h2>Settings</h2>
      </Header>

      <div className={styles.settings}>
        <h1 className={styles.heading}>Customize your view</h1>
        <h2 className={styles.subheading}>
          These settings affect all the Mention accounts on this device.
        </h2>

        <article className={styles.post}>
          <div className={styles.avatar}>
            <Avatar userImage={`/mention-avatar.jpg`} />
          </div>
          <div className={styles.content}>
            <div className={styles.user_details}>
              <EllipsisWrapper>
                <span className={styles.name}>Oxy</span>
              </EllipsisWrapper>

              <VerifiedIcon />

              <EllipsisWrapper>
                <span className={styles.username}>@Oxy</span>
              </EllipsisWrapper>

              <span className={styles.dot}>·</span>
              <span className={styles.time}>16m</span>
            </div>
            <p className={styles.post_text}>
              At the heart of Mention are short messages called Posts — just
              like this one — which can include photos, videos, links, text,
              hashtags, and mentions like <Link href="#">@Oxy</Link>.
            </p>
          </div>
        </article>

        <FontSizeCustomization />
        <ColorPicker />
        <ThemePicker />
        <LanguageSwitcher />

        <div className={styles.advancedPrivacySettings}>
          <h2>Advanced Privacy Settings</h2>
          <div className={styles.customAudienceSettings}>
            <h3>Custom Audience Settings for Posts</h3>
            <p>Set custom audience for each post.</p>
            <label>
              <input type="checkbox" />
              Enable custom audience settings
            </label>
          </div>
          <div className={styles.hideProfileSections}>
            <h3>Hide Specific Profile Sections</h3>
            <p>Choose which profile sections to hide.</p>
            <label>
              <input type="checkbox" />
              Hide followers
            </label>
            <label>
              <input type="checkbox" />
              Hide posts
            </label>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Settings;

export const metadata = {
  title: "Settings",
};
