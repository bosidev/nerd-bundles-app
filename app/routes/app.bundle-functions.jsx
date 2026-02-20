import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getBundles } from "../bundle.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const bundles = await getBundles(admin);
  return { bundles };
};

/** Extract numeric ID from Shopify GID for use in URL */
function productIdToParam(productId) {
  if (!productId || typeof productId !== "string") return "";
  const match = productId.match(/\/(\d+)$/);
  return match ? match[1] : encodeURIComponent(productId);
}

export default function BundleFunctionsPage() {
  const { bundles } = useLoaderData();

  const isEmpty = !bundles?.length;

  return (
    <s-page heading="Bundle Functions">
      {isEmpty ? (
        <s-section accessibilityLabel="Empty state section">
          <s-grid gap="base" justifyItems="center" paddingBlock="large-400">
            <s-box maxInlineSize="200px" maxBlockSize="200px">
              <s-image
                aspectRatio="1/0.5"
                src="https://cdn.shopify.com/static/images/polaris/patterns/callout.png"
                alt="A stylized graphic of four characters, each holding a puzzle piece"
              />
            </s-box>
            <s-grid justifyItems="center" maxInlineSize="450px" gap="base">
              <s-stack alignItems="center">
                <s-heading>No bundle functions yet</s-heading>
                <s-paragraph>
                  Create bundle products and configure how they work in the cart.
                </s-paragraph>
              </s-stack>
              <s-button-group>
                <s-button
                  href="/app/bundle-functions/new"
                  slot="primary-action"
                  aria-label="Create a new bundle function"
                >
                  Create your first bundle function
                </s-button>
              </s-button-group>
            </s-grid>
          </s-grid>
        </s-section>
      ) : (
        <>
          <s-section>
            <s-stack gap="base">
              <s-stack direction="inline" gap="base" alignItems="center">
                <s-heading>Your bundle functions</s-heading>
                <s-button href="/app/bundle-functions/new" variant="primary">
                  Create bundle function
                </s-button>
              </s-stack>
              <s-stack gap="small">
                {bundles.map((bundle) => {
                  const idParam = productIdToParam(bundle.productId);
                  const href = `/app/bundle-functions/${idParam}`;
                  return (
                    <s-link key={bundle.productId ?? bundle.bundleConfigId} href={href}>
                      {bundle.bundleName || "Untitled bundle"}
                    </s-link>
                  );
                })}
              </s-stack>
            </s-stack>
          </s-section>
        </>
      )}
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
