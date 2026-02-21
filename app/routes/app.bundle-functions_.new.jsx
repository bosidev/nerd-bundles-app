import { useMemo, useState } from "react";
import { Form, useNavigation } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { createBundle } from "../bundle.server";

function generatePoolId() {
  return crypto.randomUUID?.() ?? `pool-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const emptyFormState = () => ({
  productPools: [
    { id: generatePoolId(), name: "", variants: [], quantityLimitType: "no_limit", quantityLimit: 1 },
  ],
  includedVariants: [],
  bundleName: "",
  priceType: "original",
  fixedPrice: 0,
  discountPercent: 0,
});

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  return null;
};

export const action = async ({ request }) => {
  console.log("[action] entered, method:", request.method);

  const { admin, session, redirect } = await authenticate.admin(request);
  console.log("[action] authenticated");

  if (request.method !== "POST") {
    console.log("[action] early return: not POST");
    return null;
  }

  const formData = await request.formData();
  console.log("[action] formData keys:", [...formData.keys()]);

  const formStateJson = formData.get("formState");
  if (typeof formStateJson !== "string") {
    console.log("[action] early return: formState missing or not string, type:", typeof formStateJson);
    return null;
  }
  console.log("[action] formState length:", formStateJson?.length);

  let formState;
  try {
    formState = JSON.parse(formStateJson);
  } catch (parseErr) {
    console.error("[action] JSON parse error:", parseErr);
    return new Response("Invalid form data", { status: 400 });
  }

  console.log("[action] parsed formState:", JSON.stringify(formState, null, 2));
  console.log("[action] bundleName:", formState.bundleName, "productPools count:", formState.productPools?.length);

  try {
    console.log("[action] calling createBundle...");
    const { productId } = await createBundle(admin, formState);
    console.log("[action] createBundle success, productId:", productId);
    const url = new URL(request.url);
    const redirectTo = `/app/bundle-functions`;
    console.log("[action] redirecting to:", redirectTo);
    return redirect(redirectTo);
  } catch (err) {
    console.error("[action] createBundle error:", err);
    console.error("[action] error message:", err?.message);
    console.error("[action] error stack:", err?.stack);
    return new Response(err.message ?? "Failed to create bundle", { status: 422 });
  }
};

export default function Index() {
  const shopify = useAppBridge();
  const [formState, setFormState] = useState(emptyFormState);
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  function getProductsWithVariantCount(variants) {
    const byProduct = new Map();
    for (const c of variants) {
      const existing = byProduct.get(c.productId);
      if (!existing) {
        byProduct.set(c.productId, {
          productId: c.productId,
          image: c.image,
          imageAlt: c.imageAlt,
          variantCount: 1,
        });
      } else {
        existing.variantCount += 1;
      }
    }
    return Array.from(byProduct.values());
  }

  async function handleSelectProducts(poolId) {
    const pool = formState.productPools.find((p) => p.id === poolId);
    if (!pool) return;

    const selectionIds = pool.variants.reduce((acc, component) => {
      const existing = acc.find((p) => p.id === component.productId);
      if (existing) {
        existing.variants.push({ id: component.variantId });
      } else {
        acc.push({
          id: component.productId,
          variants: [{ id: component.variantId }],
        });
      }
      return acc;
    }, []);

    const selection = await shopify.resourcePicker({
      type: "product",
      action: "select",
      multiple: true,
      selectionIds,
    });
    const variants = selection?.map((product) => {
      const productImage = product.images?.[0];
      return product.variants.map((variant) => ({
        variantId: variant.id,
        image: variant.image?.originalSrc || productImage?.originalSrc,
        imageAlt: variant.image?.altText || productImage?.altText || product.title,
        productId: product.id,
      }));
    }).flat();

    if (variants?.length != null) {
      setFormState((prev) => ({
        ...prev,
        productPools: prev.productPools.map((p) =>
          p.id === poolId ? { ...p, variants } : p
        ),
      }));
    }
  }

  function addProductPool() {
    setFormState((prev) => ({
      ...prev,
      productPools: [
        ...prev.productPools,
        { id: generatePoolId(), name: "", variants: [], quantityLimitType: "no_limit", quantityLimit: 1 },
      ],
    }));
  }

  function removeProductPool(poolId) {
    setFormState((prev) => ({
      ...prev,
      productPools: prev.productPools.filter((p) => p.id !== poolId),
    }));
  }

  function setPoolName(poolId, name) {
    setFormState((prev) => ({
      ...prev,
      productPools: prev.productPools.map((p) =>
        p.id === poolId ? { ...p, name } : p
      ),
    }));
  }

  async function handleSelectIncludedVariants() {
    const includedVariants = formState.includedVariants ?? [];
    const selectionIds = includedVariants.reduce((acc, v) => {
      const existing = acc.find((p) => p.id === v.productId);
      if (existing) {
        existing.variants.push({ id: v.variantId });
      } else {
        acc.push({ id: v.productId, variants: [{ id: v.variantId }] });
      }
      return acc;
    }, []);
    const selection = await shopify.resourcePicker({
      type: "product",
      action: "select",
      multiple: true,
      selectionIds,
    });
    const variants = selection?.map((product) => {
      const productImage = product.images?.[0];
      return product.variants.map((variant) => ({
        variantId: variant.id,
        image: variant.image?.originalSrc || productImage?.originalSrc,
        imageAlt: variant.image?.altText || productImage?.altText || product.title,
        productId: product.id,
      }));
    }).flat();
    if (variants?.length != null) {
      setFormState((prev) => ({
        ...prev,
        includedVariants: variants,
      }));
    }
  }

  return (
    <s-page heading="Create bundle function">
      <Form method="post">
        <input
          type="hidden"
          name="formState"
          value={JSON.stringify(formState)}
        />
        <s-stack gap="base">
          <s-section>
            <s-text-field
              name="bundle-name"
              label="Bundle name"
              value={formState.bundleName}
              onInput={(e) =>
                setFormState((prev) => ({
                  ...prev,
                  bundleName: e.currentTarget?.value ?? e.target?.value ?? "",
                }))
              }
            />
          </s-section>
          <s-section>
            <s-text variant="headingMd" as="h2">
              Included variants
            </s-text>
            <s-text variant="bodyMd" tone="subdued">
              Product variants that are included in this bundle (optional).
            </s-text>
            <s-button
              onClick={() => handleSelectIncludedVariants()}
              type="button"
              accessibilityLabel="Select included variants"
            >
              Select included variants
            </s-button>
            {(formState.includedVariants?.length ?? 0) > 0 && (
              <s-grid padding="base" gridTemplateColumns="repeat(auto-fill, minmax(40px, 1fr))" gap="small">
                {getProductsWithVariantCount(formState.includedVariants).map((product) => (
                  <div key={`included-${product.productId}`} style={{ position: "relative", display: "block" }}>
                    <s-image
                      borderRadius="small"
                      border="base"
                      src={product.image}
                      alt={product.imageAlt ?? product.productId}
                    />
                    <span
                      style={{
                        position: "absolute",
                        top: "-50%",
                        right: "-50%",
                        transform: "translate(50%, -50%)",
                        minWidth: 18,
                        height: 18,
                        padding: "0 5px",
                        borderRadius: 9,
                        background: "var(--p-color-bg-fill-critical, #d72c0d)",
                        color: "var(--p-color-text-on-fill, #fff)",
                        fontSize: 11,
                        fontWeight: 600,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                      aria-label={`${product.variantCount} variants selected`}
                    >
                      {product.variantCount}
                    </span>
                  </div>
                ))}
              </s-grid>
            )}
          </s-section>
          <s-section>
            {formState.productPools.map((pool, index) => (
              <s-stack key={pool.id} gap="base" padding="base none">
                <s-stack gap="base" direction="inline" alignItems="center">
                  <s-text variant="headingMd" as="h2">
                    Product pool {index + 1}
                  </s-text>
                  {formState.productPools.length > 1 && (
                    <s-button
                      variant="plain"
                      tone="critical"
                      onClick={() => removeProductPool(pool.id)}
                      type="button"
                      accessibilityLabel={`Remove product pool ${index + 1}`}
                    >
                      Remove pool
                    </s-button>
                  )}
                </s-stack>
                <s-text-field
                  label="Name (optional)"
                  value={pool.name}
                  placeholder={`e.g. Main products, Add-ons`}
                  helpText="Used to group products into categories in the bundle"
                  onInput={(e) =>
                    setPoolName(pool.id, e.currentTarget?.value ?? e.target?.value ?? "")
                  }
                />
                <s-choice-list
                  label="Item quantity (this pool)"
                  name={`quantity-limit-type-${pool.id}`}
                  onChange={(e) => {
                    const target = e.currentTarget;
                    const selected = target.values[0];
                    if (selected == null) return;
                    setFormState((prev) => ({
                      ...prev,
                      productPools: prev.productPools.map((p) =>
                        p.id === pool.id ? { ...p, quantityLimitType: selected } : p
                      ),
                    }));
                  }}
                >
                  <s-choice {...(pool.quantityLimitType === "no_limit" ? { selected: true } : {})} value="no_limit">No limit</s-choice>
                  <s-choice {...(pool.quantityLimitType === "limit" ? { selected: true } : {})} value="limit">Limit</s-choice>
                </s-choice-list>
                {pool.quantityLimitType === "limit" && (
                  <s-number-field
                    label="Maximum items from this pool"
                    details="Maximum number of items allowed from this pool in the bundle"
                    placeholder="1"
                    step={1}
                    min={1}
                    value={pool.quantityLimit ?? 1}
                    onInput={(e) => {
                      const v = e.currentTarget?.value ?? e.target?.value ?? "";
                      const num = parseInt(v, 10);
                      setFormState((prev) => ({
                        ...prev,
                        productPools: prev.productPools.map((p) =>
                          p.id === pool.id
                            ? { ...p, quantityLimit: Number.isNaN(num) || num < 1 ? 1 : num }
                            : p
                        ),
                      }));
                    }}
                  />
                )}
                <s-button
                  onClick={() => handleSelectProducts(pool.id)}
                  type="button"
                  accessibilityLabel={`Select variants for product pool ${index + 1}`}
                >
                  Select variants for this pool
                </s-button>
                {pool.variants.length > 0 && (
                  <s-grid padding="base" gridTemplateColumns="repeat(auto-fill, minmax(40px, 1fr))" gap="small">
                    {getProductsWithVariantCount(pool.variants).map((product) => (
                      <div key={`${pool.id}-${product.productId}`} style={{ position: "relative", display: "block" }}>
                        <s-image
                          borderRadius="small"
                          border="base"
                          src={product.image}
                          alt={product.imageAlt ?? product.productId}
                        />
                        <span
                          style={{
                            position: "absolute",
                            top: "-50%",
                            right: "-50%",
                            transform: "translate(50%, -50%)",
                            minWidth: 18,
                            height: 18,
                            padding: "0 5px",
                            borderRadius: 9,
                            background: "var(--p-color-bg-fill-critical, #d72c0d)",
                            color: "var(--p-color-text-on-fill, #fff)",
                            fontSize: 11,
                            fontWeight: 600,
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                          aria-label={`${product.variantCount} variants selected`}
                        >
                          {product.variantCount}
                        </span>
                      </div>
                    ))}
                  </s-grid>
                )}
              </s-stack>
            ))}
            <s-button
              variant="secondary"
              onClick={addProductPool}
              type="button"
              accessibilityLabel="Add another product pool"
              icon="plus"
            >
              Add product pool
            </s-button>
          </s-section>
          <s-section>
            <s-choice-list
              label="Price type"
              name="visibility"
              onChange={(e) => {
                console.log('changed')
                const target = e.currentTarget;
                const selected = target.values[0];
                if (selected == null) return;
                setFormState((prev) => ({
                  ...prev,
                  priceType: selected,
                }));
              }}
            >
              <s-choice {...formState.priceType === "original" ? { selected: true } : {}} value="original">Original price</s-choice>
              <s-choice {...formState.priceType === "fixed" ? { selected: true } : {}} value="fixed">Fixed price</s-choice>
              <s-choice {...formState.priceType === "discounted" ? { selected: true } : {}} value="discounted">Discounted price</s-choice>
            </s-choice-list>
            {formState.priceType === "fixed" && (
              <s-money-field
                label="Fixed price"
                value={formState.fixedPrice}
                onInput={(e) => {
                  const v = e.currentTarget?.value ?? e.target?.value ?? "";
                  const num = parseFloat(v, 10);
                  setFormState((prev) => ({
                    ...prev,
                    fixedPrice: Number.isNaN(num) ? 0 : num,
                  }));
                }}
              />
            )}
            {formState.priceType === "discounted" && (
              <s-number-field
                label="Discount percentage"
                details="Percentage that gets deducted from all variants in the bundle"
                placeholder="0"
                step={1}
                min={0}
                max={100}
                value={formState.discountPercent}
                onInput={(e) => {
                  const v = e.currentTarget?.value ?? e.target?.value ?? "";
                  const num = parseFloat(v, 10);
                  setFormState((prev) => ({
                    ...prev,
                    discountPercent: Number.isNaN(num) ? 0 : Math.min(100, Math.max(0, num)),
                  }));
                }}
              />
            )}
          </s-section>
          <s-button variant="primary" type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Creating…" : "Create bundle"}
          </s-button>
        </s-stack>
      </Form>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
