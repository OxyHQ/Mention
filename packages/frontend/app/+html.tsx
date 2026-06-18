import { getSsoCallbackBootstrapScript } from '@oxyhq/core';
import { ScrollViewStyleReset } from 'expo-router/html';
import type { PropsWithChildren } from 'react';

const SSO_CALLBACK_BOOTSTRAP_SCRIPT = getSsoCallbackBootstrapScript();

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <title>Mention</title>
        <meta name="application-name" content="Mention" />
        <script dangerouslySetInnerHTML={{ __html: SSO_CALLBACK_BOOTSTRAP_SCRIPT }} />
        <ScrollViewStyleReset />
      </head>
      <body>{children}</body>
    </html>
  );
}
