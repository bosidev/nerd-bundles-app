import { useMemo, useState, useEffect, useRef } from "react";
import { useLoaderData, useNavigation, useActionData, redirect } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getBundleByProductId, getVariantDetails, updateBundle, deleteBundle } from "../bundle.server";

const SAVE_BAR_ID = "save-bar";

function generatePoolId() {
  return crypto.randomUUID?.() ?? `pool-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function bundleToFormState(bundle, variantDetails = {}) {
  if (!bundle) return null;
  const productPools = (bundle.productPools ?? []).map((pool, i) => ({
    id: pool.id || generatePoolId(),
    metaobjectId: pool.metaobjectId ?? undefined,
    name: pool.name || "",
    quantityLimitType: pool.quantityLimitType ?? "no_limit",
    quantityLimit: pool.quantityLimit ?? 1,
    variants: (pool.variantIds ?? []).map((variantId) => {
      const details = variantDetails[variantId] || {};
      return {
        variantId,
        image: details.image,
        imageAlt: details.imageAlt,
        productId: details.productId ?? variantId,
      };
    }),
  }));
  if (productPools.length === 0) {
    productPools.push({ id: generatePoolId(), name: "", variants: [], quantityLimitType: "no_limit", quantityLimit: 1 });
  }
  const includedVariants = (bundle.includedVariantIds ?? []).map((variantId) => {
    const details = variantDetails[variantId] || {};
    return {
      variantId,
      image: details.image,
      imageAlt: details.imageAlt,
      productId: details.productId ?? variantId,
    };
  });
  return {
    productPools,
    includedVariants,
    bundleName: bundle.bundleName ?? "",
    priceType: bundle.priceType ?? "original",
    fixedPrice: bundle.fixedPrice ?? 0,
    discountPercent: bundle.discountPercent ?? 0,
  };
}

export const loader = async ({ request, params }) => {
  const { admin } = await authenticate.admin(request);
  const id = params.id;
  if (!id) {
    throw new Response("Not found", { status: 404 });
  }
  const bundle = await getBundleByProductId(admin, id);
  if (!bundle) {
    throw new Response("Bundle not found", { status: 404 });
  }
  const poolVariantIds = (bundle.productPools ?? []).flatMap((p) => p.variantIds ?? []);
  const includedVariantIds = bundle.includedVariantIds ?? [];
  const allVariantIds = [...poolVariantIds, ...includedVariantIds];
  const variantDetails = await getVariantDetails(admin, allVariantIds);
  return { bundle, variantDetails };
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  if (request.method !== "POST") return null;
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "delete") {
    const productId = formData.get("productId");
    if (!productId) {
      return new Response("Invalid form data", { status: 400 });
    }
    try {
      await deleteBundle(admin, productId);
      return redirect("/app/bundle-functions");
    } catch (err) {
      console.error("[bundle-functions/$id] action: deleteBundle error:", err);
      return Response.json(
        { success: false, error: err.message ?? "Failed to delete bundle" },
        { status: 422 }
      );
    }
  }

  const formStateJson = formData.get("formState");
  const productId = formData.get("productId");
  const bundleConfigId = formData.get("bundleConfigId");
  if (typeof formStateJson !== "string" || !productId || !bundleConfigId) {
    return new Response("Invalid form data", { status: 400 });
  }
  let formState;
  try {
    formState = JSON.parse(formStateJson);
  } catch (e) {
    return new Response("Invalid form data", { status: 400 });
  }
  try {
    await updateBundle(admin, productId, bundleConfigId, formState);
    return Response.json({ success: true });
  } catch (err) {
    console.error("[bundle-functions/$id] action: updateBundle error:", err);
    return new Response(err.message ?? "Failed to update bundle", { status: 422 });
  }
};

export default function EditBundlePage() {
  const { bundle, variantDetails } = useLoaderData();
  const actionData = useActionData();
  const shopify = useAppBridge();
  const initialFormState = useMemo(() => {
    const state = bundleToFormState(bundle, variantDetails);
    return state;
  }, [bundle, variantDetails]);
  const [formState, setFormState] = useState(initialFormState ?? {
    productPools: [{ id: generatePoolId(), name: "", variants: [], quantityLimitType: "no_limit", quantityLimit: 1 }],
    includedVariants: [],
    bundleName: "",
    priceType: "original",
    fixedPrice: 0,
    discountPercent: 0,
  });
  const saveBarRef = useRef(null);
  const deleteFormRef = useRef(null);
  const docsModalRef = useRef(null);
  const navigation = useNavigation();

  const isDirty = useMemo(
    () => JSON.stringify(formState) !== JSON.stringify(initialFormState),
    [formState, initialFormState]
  );

  useEffect(() => {
    const el = saveBarRef.current;
    if (!el) return;
    if (isDirty) {
      el.show();
    } else {
      el.hide();
    }
  }, [isDirty]);

  // After successful save, sync form to revalidated loader data so save bar hides
  useEffect(() => {
    if (actionData?.success && navigation.state === "idle" && initialFormState) {
      setFormState(initialFormState);
    }
  }, [actionData?.success, navigation.state, initialFormState]);

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

  function handleDiscard() {
    setFormState(initialFormState);
    saveBarRef.current?.hide();
  }

  function handleDeleteClick() {
    if (
      window.confirm(
        "Permanently delete this bundle? This will remove the product, all associated metaobjects (bundle config and product pools), and the cart transform data. This cannot be undone."
      )
    ) {
      deleteFormRef.current?.requestSubmit();
    }
  }

  if (!bundle || !initialFormState) {
    return null;
  }

  const DOCS_MODAL_ID = "docs-modal";

  return (
    <s-page heading={bundle.bundleName || "Edit bundle function"}>
      <s-button slot="secondaryActions" variant="secondary" command="--show" commandFor={DOCS_MODAL_ID} icon="book" accessibilityLabel="Open frontend integration docs">
        Frontend docs
      </s-button>
      <s-modal
        id={DOCS_MODAL_ID}
        ref={docsModalRef}
        heading="Applying bundle data on the frontend"
        accessibilityLabel="Documentation: how to apply bundle data on the frontend"
        size="large"
      >
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
      </s-modal>
      <ui-save-bar id={SAVE_BAR_ID} ref={saveBarRef}>
        <button form="edit-bundle-form" variant="primary" type="submit">
          Save
        </button>
        <button type="button" onClick={handleDiscard}>
          Discard
        </button>
      </ui-save-bar>

      <form method="post" id="edit-bundle-form">
        <input type="hidden" name="formState" value={JSON.stringify(formState)} />
        <input type="hidden" name="productId" value={bundle.productId} />
        <input type="hidden" name="bundleConfigId" value={bundle.bundleConfigId} />
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
                      src={product.image || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'%3E%3Crect fill='%23f1f1f1' width='40' height='40'/%3E%3C/svg%3E"}
                      alt={product.imageAlt ?? product.productId ?? ""}
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
                  placeholder="e.g. Main products, Add-ons"
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
                          src={product.image || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'%3E%3Crect fill='%23f1f1f1' width='40' height='40'/%3E%3C/svg%3E"}
                          alt={product.imageAlt ?? product.productId ?? ""}
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
                const target = e.currentTarget;
                const selected = target.values[0];
                if (selected == null) return;
                setFormState((prev) => ({ ...prev, priceType: selected }));
              }}
            >
              <s-choice {...(formState.priceType === "original" ? { selected: true } : {})} value="original">Original price</s-choice>
              <s-choice {...(formState.priceType === "fixed" ? { selected: true } : {})} value="fixed">Fixed price</s-choice>
              <s-choice {...(formState.priceType === "discounted" ? { selected: true } : {})} value="discounted">Discounted price</s-choice>
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
          <s-section>
            <s-stack gap="base" padding="base none">
              <s-text variant="headingMd" as="h2" tone="critical">
                Danger zone
              </s-text>
              {actionData?.error && (
                <s-banner tone="critical" onDismiss={() => {}}>
                  {actionData.error}
                </s-banner>
              )}
              <form method="post" id="delete-bundle-form" ref={deleteFormRef}>
                <input type="hidden" name="intent" value="delete" />
                <input type="hidden" name="productId" value={bundle.productId} />
                <s-button
                  type="button"
                  variant="primary"
                  tone="critical"
                  onClick={handleDeleteClick}
                  accessibilityLabel="Delete this bundle permanently"
                >
                  Delete bundle
                </s-button>
              </form>
            </s-stack>
          </s-section>
        </s-stack>
      </form>
    </s-page>
  );
}


export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
