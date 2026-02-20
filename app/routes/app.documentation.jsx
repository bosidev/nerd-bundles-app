import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return {};
};

export default function DocumentationPage() {
  return (
    <s-page heading="Applying bundle data on the frontend">
      <s-section accessibilityLabel="Frontend integration documentation">
        <s-stack gap="base">
          <s-text variant="bodyMd">
            When adding bundle items to the cart (Storefront API, Ajax API, or theme), set line item attributes so the cart transform can merge and price them.
          </s-text>
          <s-text variant="headingSm">Required line item attributes</s-text>
          <s-text variant="bodyMd">
            <strong>_bundleId</strong> — Unique identifier for this bundle instance (e.g. a UUID).
          </s-text>
          <s-text variant="bodyMd">
            <strong>_bundleName</strong> — Must match the Bundle name configured in this app (used for pricing).
          </s-text>
          <s-text variant="bodyMd">
            <strong>_bundleSize</strong> — Number of items that form one complete bundle (e.g. 3 if the bundle has 3 component variants).
          </s-text>
          <s-text variant="headingSm">Example (Storefront API)</s-text>
          <s-text variant="bodyMd">
            When calling cartLinesAdd, pass attributes on each line: {"[{ \"key\": \"_bundleId\", \"value\": \"<unique-id>\" }, { \"key\": \"_bundleName\", \"value\": \"<bundle name>\" }, { \"key\": \"_bundleSize\", \"value\": \"3\" }]"}
          </s-text>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
