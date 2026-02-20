import { useEffect } from "react";
import { useFetcher } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  return null;
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  return null;
};

export default function Index() {

  return (
    <s-page heading="Bundle functions">
      <s-section accessibilityLabel="Empty state section">
        <s-grid gap="base" justifyItems="center" paddingBlock="large-400">
          <s-box maxInlineSize="200px" maxBlockSize="200px">
            {/* aspectRatio should match the actual image dimensions (width/height) */}
            <s-image
              aspectRatio="1/0.5"
              src="https://cdn.shopify.com/static/images/polaris/patterns/callout.png"
              alt="A stylized graphic of four characters, each holding a puzzle piece"
            />
          </s-box>
          <s-grid justifyItems="center" maxInlineSize="450px" gap="base">
            <s-stack alignItems="center">
              <s-heading>Start creating puzzles</s-heading>
              <s-paragraph>
                Create and manage your bundle functions.
              </s-paragraph>
            </s-stack>
            <s-button-group>
              <s-button href="/app/bundle-functions/new" slot="primary-action" aria-label="Add a new puzzle">
                {" "}
                Create your first bundle function{" "}
              </s-button>
            </s-button-group>
          </s-grid>
        </s-grid>
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
