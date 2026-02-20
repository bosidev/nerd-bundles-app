/**
 * Server-side logic for creating bundles: metaobjects, products, and cart transform metafield.
 */

const BUNDLE_FUNCTION_HANDLE = "bundle-function";

/**
 * Get the shop's currency code
 * @param {object} admin
 * @returns {Promise<string>}
 */
async function getShopCurrencyCode(admin) {
  const query = `query { shop { currencyCode } }`;
  const response = await admin.graphql(query);
  const json = await response.json();
  return json.data?.shop?.currencyCode ?? "USD";
}

/**
 * Ensure variant IDs are in GID format
 * @param {string} id - variant or product ID (may be GID or numeric)
 * @returns {string} GID
 */
function toVariantGid(id) {
  if (typeof id !== "string") return `gid://shopify/ProductVariant/${id}`;
  if (id.startsWith("gid://")) return id;
  return `gid://shopify/ProductVariant/${id}`;
}

/**
 * Create product_pool metaobjects for each pool
 * @param {object} admin - Shopify Admin API client
 * @param {Array<{id: string, name: string, variants: Array<{variantId: string}>}>} productPools
 * @param {string} [bundleConfigId] - optional bundle_config GID to link pools to (for cleanup on delete)
 * @returns {Promise<string[]>} Array of created product_pool metaobject GIDs
 */
async function createProductPoolMetaobjects(admin, productPools, bundleConfigId) {
  const poolIds = [];
  for (const pool of productPools) {
    const variantRefs = pool.variants.map((v) => toVariantGid(v.variantId));
    const value = JSON.stringify(variantRefs);
    const fields = [
      { key: "name", value: pool.name || `Pool ${poolIds.length + 1}` },
      { key: "variants", value },
      { key: "quantity_limit_type", value: pool.quantityLimitType ?? "no_limit" },
      { key: "quantity_limit", value: String(pool.quantityLimit ?? 1) },
    ];
    if (bundleConfigId) {
      fields.push({ key: "bundle_config_id", value: bundleConfigId });
    }

    const mutation = `
      mutation CreateProductPool($metaobject: MetaobjectCreateInput!) {
        metaobjectCreate(metaobject: $metaobject) {
          metaobject { id }
          userErrors { field message }
        }
      }
    `;
    const response = await admin.graphql(mutation, {
      variables: {
        metaobject: {
          type: "$app:product_pool",
          fields,
        },
      },
    });
    const json = await response.json();
    const { metaobjectCreate } = json.data;
    if (metaobjectCreate.userErrors?.length) {
      throw new Error(
        `Failed to create product pool: ${metaobjectCreate.userErrors.map((e) => e.message).join(", ")}`
      );
    }
    const poolId = metaobjectCreate.metaobject.id;
    poolIds.push(poolId);
    console.log("[bundle] Created product_pool metaobject:", {
      id: poolId,
      name: pool.name || `Pool ${poolIds.length}`,
      variantCount: pool.variants.length,
    });
  }
  return poolIds;
}

/**
 * Update an existing product_pool metaobject in place.
 * @param {object} admin
 * @param {string} metaobjectId - product_pool metaobject GID
 * @param {{ name?: string, variants: Array<{variantId: string}> }} pool
 * @param {string} [bundleConfigId] - optional bundle_config GID (keeps pool linked for cleanup on delete)
 */
async function updateProductPoolMetaobject(admin, metaobjectId, pool, bundleConfigId) {
  const variantRefs = (pool.variants ?? []).map((v) => toVariantGid(v.variantId));
  const value = JSON.stringify(variantRefs);
  const fields = [
    { key: "name", value: pool.name || "" },
    { key: "variants", value },
    { key: "quantity_limit_type", value: pool.quantityLimitType ?? "no_limit" },
    { key: "quantity_limit", value: String(pool.quantityLimit ?? 1) },
  ];
  if (bundleConfigId) {
    fields.push({ key: "bundle_config_id", value: bundleConfigId });
  }
  const mutation = `
    mutation UpdateProductPool($id: ID!, $metaobject: MetaobjectUpdateInput!) {
      metaobjectUpdate(id: $id, metaobject: $metaobject) {
        metaobject { id }
        userErrors { field message }
      }
    }
  `;
  const response = await admin.graphql(mutation, {
    variables: {
      id: metaobjectId,
      metaobject: { fields },
    },
  });
  const json = await response.json();
  const { metaobjectUpdate } = json.data;
  if (metaobjectUpdate.userErrors?.length) {
    throw new Error(
      `Failed to update product pool: ${metaobjectUpdate.userErrors.map((e) => e.message).join(", ")}`
    );
  }
  console.log("[bundle] Updated product_pool metaobject:", { id: metaobjectId, variantCount: variantRefs.length });
}

/**
 * For each pool: update existing product_pool metaobject if metaobjectId is set, otherwise create new.
 * Returns array of product_pool metaobject GIDs in the same order as productPools.
 * @param {object} admin
 * @param {Array<{metaobjectId?: string, name?: string, variants: Array<{variantId: string}>}>} productPools
 * @param {string} [bundleConfigId] - optional bundle_config GID to link pools to (for cleanup on delete)
 * @returns {Promise<string[]>}
 */
async function getOrUpdateProductPoolMetaobjectIds(admin, productPools, bundleConfigId) {
  const poolIds = [];
  for (let i = 0; i < productPools.length; i++) {
    const pool = productPools[i];
    if (pool.metaobjectId) {
      await updateProductPoolMetaobject(admin, pool.metaobjectId, pool, bundleConfigId);
      poolIds.push(pool.metaobjectId);
    } else {
      const created = await createProductPoolMetaobjects(admin, [pool], bundleConfigId);
      poolIds.push(created[0]);
    }
  }
  return poolIds;
}

/**
 * Set bundle_config_id on product_pool metaobjects (used after creating a new bundle so pools are linked for cleanup).
 * @param {object} admin
 * @param {string[]} productPoolMetaobjectIds - GIDs of product_pool metaobjects
 * @param {string} bundleConfigId - bundle_config metaobject GID
 */
async function setBundleConfigIdOnProductPools(admin, productPoolMetaobjectIds, bundleConfigId) {
  const mutation = `
    mutation UpdateProductPoolBundleConfigId($id: ID!, $metaobject: MetaobjectUpdateInput!) {
      metaobjectUpdate(id: $id, metaobject: $metaobject) {
        metaobject { id }
        userErrors { field message }
      }
    }
  `;
  for (const poolId of productPoolMetaobjectIds) {
    const response = await admin.graphql(mutation, {
      variables: {
        id: poolId,
        metaobject: {
          fields: [{ key: "bundle_config_id", value: bundleConfigId }],
        },
      },
    });
    const json = await response.json();
    const { metaobjectUpdate } = json.data;
    if (metaobjectUpdate.userErrors?.length) {
      console.warn("[bundle] setBundleConfigIdOnProductPools: metaobjectUpdate userErrors:", metaobjectUpdate.userErrors);
    }
  }
}

/**
 * Format value for money-type metafield
 * @param {number} amount
 * @param {string} currencyCode - e.g. "USD"
 */
function formatMoneyValue(amount, currencyCode) {
  return JSON.stringify({
    amount: String(Number(amount ?? 0).toFixed(2)),
    currency_code: currencyCode || "USD",
  });
}

/**
 * Create bundle_config metaobject
 * @param {object} admin
 * @param {object} formState
 * @param {string[]} productPoolMetaobjectIds
 * @param {string} shopCurrencyCode
 */
async function createBundleConfigMetaobject(admin, formState, productPoolMetaobjectIds, shopCurrencyCode) {
  const productPoolRefs = JSON.stringify(productPoolMetaobjectIds);
  const includedVariantRefs = JSON.stringify(
    (formState.includedVariants ?? []).map((v) => toVariantGid(v.variantId))
  );
  const fixedPriceValue = formatMoneyValue(formState.fixedPrice ?? 0, shopCurrencyCode);
  const mutation = `
    mutation CreateBundleConfig($metaobject: MetaobjectCreateInput!) {
      metaobjectCreate(metaobject: $metaobject) {
        metaobject { id }
        userErrors { field message }
      }
    }
  `;
  const response = await admin.graphql(mutation, {
    variables: {
        metaobject: {
          type: "$app:bundle_config",
          fields: [
            { key: "name", value: formState.bundleName },
            { key: "price_type", value: formState.priceType },
            { key: "fixed_price", value: fixedPriceValue },
            { key: "discount_percentage", value: String(formState.discountPercent ?? 0) },
            { key: "product_pools", value: productPoolRefs },
            { key: "included_variants", value: includedVariantRefs },
          ],
      },
    },
  });
  const json = await response.json();
  const { metaobjectCreate } = json.data;
  if (metaobjectCreate.userErrors?.length) {
    throw new Error(
      `Failed to create bundle config: ${metaobjectCreate.userErrors.map((e) => e.message).join(", ")}`
    );
  }
  const bundleConfigId = metaobjectCreate.metaobject.id;

  // Log the created bundle_config metaobject
  const fetchQuery = `
    query GetBundleConfigMetaobject($id: ID!) {
      metaobject(id: $id) {
        id
        handle
        type
        fields {
          key
          value
        }
      }
    }
  `;
  const fetchResponse = await admin.graphql(fetchQuery, { variables: { id: bundleConfigId } });
  const fetchJson = await fetchResponse.json();
  const metaobject = fetchJson.data?.metaobject;
  if (metaobject) {
    console.log("[bundle] Created bundle_config metaobject:", JSON.stringify(metaobject, null, 2));
  } else {
    console.log("[bundle] Created bundle_config metaobject id:", bundleConfigId);
  }

  return bundleConfigId;
}

/**
 * Create product with bundle_config metafield
 * @param {object} admin
 * @param {string} bundleName
 * @param {string} bundleConfigMetaobjectId
 */
async function createBundleProduct(admin, bundleName, bundleConfigMetaobjectId) {
  const mutation = `
    mutation CreateBundleProduct($product: ProductCreateInput!) {
      productCreate(product: $product) {
        product { id }
        userErrors { field message }
      }
    }
  `;
  const response = await admin.graphql(mutation, {
    variables: {
      product: {
        title: bundleName,
        status: "DRAFT",
        metafields: [
          {
            namespace: "$app",
            key: "bundle_config",
            type: "metaobject_reference",
            value: bundleConfigMetaobjectId,
          },
        ],
      },
    },
  });
  const json = await response.json();
  const { productCreate } = json.data;
  if (productCreate.userErrors?.length) {
    throw new Error(
      `Failed to create product: ${productCreate.userErrors.map((e) => e.message).join(", ")}`
    );
  }
  const productId = productCreate.product.id;
  console.log("[bundle] Created product with bundle_config metafield:", {
    productId,
    title: bundleName,
    bundleConfigMetaobjectId,
    metafield: { namespace: "$app", key: "bundle_config", type: "metaobject_reference", value: bundleConfigMetaobjectId },
  });
  return productId;
}

/**
 * Get list of bundle functions created by this app (from cart transform metafield).
 * Does not create a cart transform if none exists.
 * @param {object} admin
 * @returns {Promise<Array<{productId: string, bundleName: string, bundleConfigId: string, [key: string]: unknown}>>}
 */
export async function getBundles(admin) {
  const query = `
    query GetCartTransforms {
      cartTransforms(first: 10) {
        nodes {
          id
          metafield(namespace: "$app", key: "bundle_config_json") {
            value
          }
        }
      }
    }
  `;
  const response = await admin.graphql(query);
  const json = await response.json();
  const nodes = json.data?.cartTransforms?.nodes ?? [];
  const node = nodes[0];
  if (!node?.metafield?.value) return [];
  try {
    const data = JSON.parse(node.metafield.value);
    return Array.isArray(data?.bundles) ? data.bundles : [];
  } catch {
    return [];
  }
}

/**
 * Get or create the cart transform for bundle-function
 * @param {object} admin
 * @returns {Promise<{id: string, bundleConfigJson: object | null}>}
 */
async function getOrCreateCartTransform(admin) {
  const query = `
    query GetCartTransforms {
      cartTransforms(first: 10) {
        nodes {
          id
          functionId
          metafield(namespace: "$app", key: "bundle_config_json") {
            value
          }
        }
      }
    }
  `;
  const response = await admin.graphql(query);
  const json = await response.json();
  const nodes = json.data?.cartTransforms?.nodes ?? [];

  const existing = nodes[0];
  if (existing) {
    let bundleConfigJson = null;
    const mf = existing.metafield;
    try {
      bundleConfigJson = mf?.value ? JSON.parse(mf.value) : null;
    } catch {
      bundleConfigJson = null;
    }
    return { id: existing.id, bundleConfigJson };
  }

  const createMutation = `
    mutation CreateCartTransform {
      cartTransformCreate(functionHandle: "${BUNDLE_FUNCTION_HANDLE}") {
        cartTransform { id }
        userErrors { field message }
      }
    }
  `;
  const createResponse = await admin.graphql(createMutation);
  const createJson = await createResponse.json();
  const { cartTransformCreate } = createJson.data;
  if (cartTransformCreate.userErrors?.length) {
    throw new Error(
      `Failed to create cart transform: ${cartTransformCreate.userErrors.map((e) => e.message).join(", ")}`
    );
  }
  return { id: cartTransformCreate.cartTransform.id, bundleConfigJson: null };
}

/**
 * Update cart transform bundle_config_json metafield with merged bundle data
 * @param {object} admin
 * @param {string} cartTransformId
 * @param {object} existingData - current JSON or null
 * @param {object} newBundle - new bundle config to add
 */
async function updateCartTransformBundleConfig(admin, cartTransformId, existingData, newBundle) {
  const bundles = existingData?.bundles ?? [];
  bundles.push(newBundle);

  const mutation = `
    mutation SetCartTransformMetafield($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id }
        userErrors { field message }
      }
    }
  `;
  const value = JSON.stringify({ bundles });
  const response = await admin.graphql(mutation, {
    variables: {
      metafields: [
        {
          ownerId: cartTransformId,
          namespace: "$app",
          key: "bundle_config_json",
          type: "json",
          value,
        },
      ],
    },
  });
  const json = await response.json();
  const { metafieldsSet } = json.data;
  if (metafieldsSet.userErrors?.length) {
    throw new Error(
      `Failed to set cart transform metafield: ${metafieldsSet.userErrors.map((e) => e.message).join(", ")}`
    );
  }
}

/**
 * Build the JSON structure for a bundle (for cart transform).
 * Uses variantId (parent product's variant) for the cart transform; productId kept for app routing.
 */
function buildBundleConfigJson(formState, productId, variantId, bundleConfigMetaobjectId, productPools) {
  const includedVariantIds = (formState.includedVariants ?? []).map((v) => toVariantGid(v.variantId));
  return {
    productId,
    variantId: variantId ?? null,
    bundleConfigId: bundleConfigMetaobjectId,
    bundleName: formState.bundleName,
    productPools: productPools.map((pool, i) => ({
      id: pool.id,
      name: pool.name || `Pool ${i + 1}`,
      variantIds: pool.variants.map((v) => toVariantGid(v.variantId)),
      quantityLimitType: pool.quantityLimitType ?? "no_limit",
      quantityLimit: pool.quantityLimit ?? 1,
    })),
    includedVariantIds,
    priceType: formState.priceType,
    fixedPrice: formState.fixedPrice ?? 0,
    discountPercent: formState.discountPercent ?? 0,
  };
}

/**
 * Fetch product_pool metaobject GIDs from a bundle_config metaobject (by id).
 * @param {object} admin
 * @param {string} bundleConfigId - bundle_config metaobject GID
 * @returns {Promise<string[]>} Array of product_pool metaobject GIDs in order
 */
async function getProductPoolMetaobjectIds(admin, bundleConfigId) {
  const query = `
    query GetBundleConfigProductPools($id: ID!) {
      metaobject(id: $id) {
        id
        field(key: "product_pools") { value }
      }
    }
  `;
  const response = await admin.graphql(query, { variables: { id: bundleConfigId } });
  const json = await response.json();
  const value = json.data?.metaobject?.field?.value;
  if (!value) return [];
  try {
    const arr = JSON.parse(value);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

/**
 * Fetch all product_pool metaobject GIDs that belong to this bundle_config (by bundle_config_id field).
 * Includes pools that were previously removed from the bundle, so they can be deleted when the bundle is deleted.
 * Uses paginated list + filter so it works even when the field is not marked filterable in the definition.
 * @param {object} admin
 * @param {string} bundleConfigId - bundle_config metaobject GID
 * @returns {Promise<string[]>} Array of product_pool metaobject GIDs
 */
async function getProductPoolMetaobjectIdsByBundleConfig(admin, bundleConfigId) {
  const ids = [];
  let hasNextPage = true;
  let cursor = null;
  const type = "$app:product_pool";

  while (hasNextPage) {
    const query = `
      query ListProductPools($first: Int!, $after: String) {
        metaobjects(first: $first, type: "${type}", after: $after) {
          edges {
            node {
              id
              field(key: "bundle_config_id") { value }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    `;
    const response = await admin.graphql(query, { variables: { first: 250, after: cursor } });
    const json = await response.json();
    if (json.errors?.length) throw new Error(json.errors[0].message);
    const { edges, pageInfo } = json.data?.metaobjects ?? {};
    for (const edge of edges ?? []) {
      const node = edge?.node;
      if (!node?.id) continue;
      const value = node.field?.value;
      if (value === bundleConfigId) ids.push(node.id);
    }
    hasNextPage = pageInfo?.hasNextPage ?? false;
    cursor = pageInfo?.endCursor ?? null;
  }
  return ids;
}

/**
 * Get a single bundle by product ID (numeric part or full GID).
 * Enriches productPools with metaobjectId so the edit form can update existing pools in place.
 * @param {object} admin
 * @param {string} idParam - route param: numeric product ID or full product GID
 * @returns {Promise<{productId: string, bundleConfigId: string, bundleName: string, productPools: Array, [key: string]: unknown} | null>}
 */
export async function getBundleByProductId(admin, idParam) {
  const bundles = await getBundles(admin);
  console.log("[bundle] getBundleByProductId: idParam =", idParam, "bundles count =", bundles.length, "productIds =", bundles.map((b) => b.productId));
  const normalized = String(idParam).trim();
  const match = bundles.find((b) => {
    const pid = b.productId ?? "";
    const ok = pid === normalized || pid.endsWith(`/${normalized}`);
    if (ok) console.log("[bundle] getBundleByProductId: match pid =", pid);
    return ok;
  });
  if (!match) {
    console.log("[bundle] getBundleByProductId: match = null");
    return null;
  }
  const bundleConfigId = match.bundleConfigId;
  if (bundleConfigId && match.productPools?.length) {
    const poolGids = await getProductPoolMetaobjectIds(admin, bundleConfigId);
    const enrichedPools = match.productPools.map((pool, i) => ({
      ...pool,
      metaobjectId: poolGids[i] ?? undefined,
    }));
    return { ...match, productPools: enrichedPools };
  }
  console.log("[bundle] getBundleByProductId: match = found");
  return match;
}

/**
 * Fetch image and product info for variant IDs (for edit page product pool display).
 * @param {object} admin
 * @param {string[]} variantIds - GIDs or numeric variant IDs
 * @returns {Promise<Record<string, { image?: string, imageAlt?: string, productId?: string }>>} map by variant GID
 */
export async function getVariantDetails(admin, variantIds) {
  if (!variantIds?.length) return {};
  const gids = variantIds.map((id) => toVariantGid(id));
  const query = `
    query GetVariantDetails($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on ProductVariant {
          id
          media(first: 1) {
            nodes {
              ... on MediaImage {
                alt
                image { url }
                preview { image { url } }
              }
            }
          }
          product {
            id
            title
            featuredMedia {
              ... on MediaImage {
                alt
                image { url }
                preview { image { url } }
              }
            }
          }
        }
      }
    }
  `;
  const response = await admin.graphql(query, { variables: { ids: gids } });
  const json = await response.json();
  const nodes = json.data?.nodes ?? [];
  const out = {};
  for (const node of nodes) {
    if (!node?.id) continue;
    const variantMedia = node.media?.nodes?.[0];
    const variantImageUrl =
      variantMedia?.image?.url ?? variantMedia?.preview?.image?.url;
    const productMedia = node.product?.featuredMedia;
    const productImageUrl =
      productMedia?.image?.url ?? productMedia?.preview?.image?.url;
    const image = variantImageUrl ?? productImageUrl ?? undefined;
    const imageAlt =
      node.product?.title ?? variantMedia?.alt ?? undefined;
    const productId = node.product?.id ?? undefined;
    out[node.id] = { image, imageAlt, productId };
  }
  return out;
}

/**
 * Update bundle_config metaobject fields (same type as create, but update by id).
 */
async function updateBundleConfigMetaobject(admin, bundleConfigId, formState, productPoolMetaobjectIds, shopCurrencyCode) {
  console.log("[bundle] updateBundleConfigMetaobject: bundleConfigId =", bundleConfigId, "poolIds count =", productPoolMetaobjectIds.length);
  const productPoolRefs = JSON.stringify(productPoolMetaobjectIds);
  const includedVariantRefs = JSON.stringify(
    (formState.includedVariants ?? []).map((v) => toVariantGid(v.variantId))
  );
  const fixedPriceValue = formatMoneyValue(formState.fixedPrice ?? 0, shopCurrencyCode);
  const mutation = `
    mutation UpdateBundleConfig($id: ID!, $metaobject: MetaobjectUpdateInput!) {
      metaobjectUpdate(id: $id, metaobject: $metaobject) {
        metaobject { id }
        userErrors { field message }
      }
    }
  `;
  const response = await admin.graphql(mutation, {
    variables: {
      id: bundleConfigId,
      metaobject: {
        fields: [
          { key: "name", value: formState.bundleName },
          { key: "price_type", value: formState.priceType },
          { key: "fixed_price", value: fixedPriceValue },
          { key: "discount_percentage", value: String(formState.discountPercent ?? 0) },
          { key: "product_pools", value: productPoolRefs },
          { key: "included_variants", value: includedVariantRefs },
        ],
      },
    },
  });
  const json = await response.json();
  const { metaobjectUpdate } = json.data;
  if (metaobjectUpdate.userErrors?.length) {
    console.error("[bundle] updateBundleConfigMetaobject userErrors:", metaobjectUpdate.userErrors);
    throw new Error(
      `Failed to update bundle config: ${metaobjectUpdate.userErrors.map((e) => e.message).join(", ")}`
    );
  }
  console.log("[bundle] updateBundleConfigMetaobject: success");
}

/**
 * Update product title and bundle_config metafield for a bundle product.
 */
async function updateBundleProduct(admin, productId, bundleName, bundleConfigMetaobjectId) {
  console.log("[bundle] updateBundleProduct: productId =", productId, "bundleName =", bundleName);
  const mutation = `
    mutation UpdateBundleProduct($product: ProductUpdateInput!) {
      productUpdate(product: $product) {
        product { id }
        userErrors { field message }
      }
    }
  `;
  const response = await admin.graphql(mutation, {
    variables: {
      product: {
        id: productId,
        title: bundleName,
        metafields: [
          {
            namespace: "$app",
            key: "bundle_config",
            type: "metaobject_reference",
            value: bundleConfigMetaobjectId,
          },
        ],
      },
    },
  });
  const json = await response.json();
  const { productUpdate } = json.data;
  if (productUpdate.userErrors?.length) {
    console.error("[bundle] updateBundleProduct userErrors:", productUpdate.userErrors);
    throw new Error(
      `Failed to update product: ${productUpdate.userErrors.map((e) => e.message).join(", ")}`
    );
  }
  console.log("[bundle] updateBundleProduct: success");
}

/**
 * Set the full bundles array on the cart transform metafield.
 */
async function setCartTransformBundles(admin, cartTransformId, bundles) {
  console.log("[bundle] setCartTransformBundles: cartTransformId =", cartTransformId, "bundles count =", bundles.length);
  const mutation = `
    mutation SetCartTransformMetafield($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { id }
        userErrors { field message }
      }
    }
  `;
  const value = JSON.stringify({ bundles });
  const response = await admin.graphql(mutation, {
    variables: {
      metafields: [
        {
          ownerId: cartTransformId,
          namespace: "$app",
          key: "bundle_config_json",
          type: "json",
          value,
        },
      ],
    },
  });
  const json = await response.json();
  const { metafieldsSet } = json.data;
  if (metafieldsSet.userErrors?.length) {
    console.error("[bundle] setCartTransformBundles userErrors:", metafieldsSet.userErrors);
    throw new Error(
      `Failed to set cart transform metafield: ${metafieldsSet.userErrors.map((e) => e.message).join(", ")}`
    );
  }
  console.log("[bundle] setCartTransformBundles: success");
}

/**
 * Ensure product ID is in GID format
 * @param {string} id - product ID (may be GID or numeric)
 * @returns {string} GID
 */
function toProductGid(id) {
  if (typeof id !== "string") return `gid://shopify/Product/${id}`;
  if (id.startsWith("gid://")) return id;
  return `gid://shopify/Product/${id}`;
}

/**
 * Get the first variant GID for a product (for use in cart transform as parent variant).
 * @param {object} admin
 * @param {string} productId - product GID or numeric ID
 * @returns {Promise<string | null>}
 */
async function getFirstVariantIdForProduct(admin, productId) {
  const gid = toProductGid(productId);
  const query = `
    query GetProductFirstVariant($id: ID!) {
      product(id: $id) {
        id
        variants(first: 1) {
          nodes { id }
        }
      }
    }
  `;
  const response = await admin.graphql(query, { variables: { id: gid } });
  const json = await response.json();
  const node = json.data?.product?.variants?.nodes?.[0];
  return node?.id ?? null;
}

/**
 * Delete a bundle: remove from cart transform metafield, delete product_pool and bundle_config
 * metaobjects, then delete the product.
 * @param {object} admin
 * @param {string} productIdParam - product ID (numeric or GID)
 */
export async function deleteBundle(admin, productIdParam) {
  const productId = toProductGid(productIdParam);
  const bundle = await getBundleByProductId(admin, productIdParam);
  if (!bundle) {
    throw new Error("Bundle not found");
  }
  const { bundleConfigId } = bundle;

  // 1. Remove this bundle from cart transform metafield
  const { id: cartTransformId, bundleConfigJson } = await getOrCreateCartTransform(admin);
  const existingBundles = bundleConfigJson?.bundles ?? [];
  const productIdNum = String(productIdParam).replace(/.*\//, "");
  const bundles = existingBundles.filter((b) => {
    const bPid = b.productId ?? "";
    return bPid !== productId && !bPid.endsWith(`/${productIdNum}`);
  });
  await setCartTransformBundles(admin, cartTransformId, bundles);
  console.log("[bundle] deleteBundle: removed from cart transform, bundles left =", bundles.length);

  // 2. Delete all product_pool metaobjects linked to this bundle (current + any previously removed from bundle)
  const poolsFromConfig = await getProductPoolMetaobjectIds(admin, bundleConfigId);
  const poolsByBundleConfigId = await getProductPoolMetaobjectIdsByBundleConfig(admin, bundleConfigId);
  const allPoolIds = [...new Set([...poolsFromConfig, ...poolsByBundleConfigId])];
  console.log("[bundle] deleteBundle: deleting product pools, from config =", poolsFromConfig.length, "by bundle_config_id =", poolsByBundleConfigId.length, "total =", allPoolIds.length);
  for (const metaobjectId of allPoolIds) {
    const mutation = `
      mutation DeleteMetaobject($id: ID!) {
        metaobjectDelete(id: $id) {
          deletedId
          userErrors { field message }
        }
      }
    `;
    const response = await admin.graphql(mutation, { variables: { id: metaobjectId } });
    const json = await response.json();
    const { metaobjectDelete } = json.data;
    if (metaobjectDelete.userErrors?.length) {
      console.warn("[bundle] deleteBundle: metaobjectDelete userErrors:", metaobjectDelete.userErrors);
    }
  }
  const deleteConfigMutation = `
    mutation DeleteMetaobject($id: ID!) {
      metaobjectDelete(id: $id) {
        deletedId
        userErrors { field message }
      }
    }
  `;
  const configResponse = await admin.graphql(deleteConfigMutation, { variables: { id: bundleConfigId } });
  const configJson = await configResponse.json();
  const { metaobjectDelete: configDelete } = configJson.data;
  if (configDelete.userErrors?.length) {
    throw new Error(
      `Failed to delete bundle config: ${configDelete.userErrors.map((e) => e.message).join(", ")}`
    );
  }
  console.log("[bundle] deleteBundle: deleted metaobjects");

  // 3. Delete the product
  const productDeleteMutation = `
    mutation ProductDelete($input: ProductDeleteInput!) {
      productDelete(input: $input) {
        deletedProductId
        userErrors { field message }
      }
    }
  `;
  const productResponse = await admin.graphql(productDeleteMutation, {
    variables: { input: { id: productId } },
  });
  const productJson = await productResponse.json();
  const { productDelete } = productJson.data;
  if (productDelete.userErrors?.length) {
    throw new Error(
      `Failed to delete product: ${productDelete.userErrors.map((e) => e.message).join(", ")}`
    );
  }
  console.log("[bundle] deleteBundle: deleted product", productId);
}

/**
 * Update an existing bundle: product, bundle_config metaobject, and cart transform JSON.
 * @param {object} admin
 * @param {string} productId - bundle product GID
 * @param {string} bundleConfigId - existing bundle_config metaobject GID
 * @param {object} formState - same shape as create bundle form
 */
export async function updateBundle(admin, productId, bundleConfigId, formState) {
  console.log("[bundle] updateBundle: productId =", productId, "bundleConfigId =", bundleConfigId, "bundleName =", formState?.bundleName);
  if (!formState.bundleName?.trim()) {
    throw new Error("Bundle name is required");
  }
  if (!formState.productPools?.length || formState.productPools.every((p) => !p.variants?.length)) {
    throw new Error("At least one product pool with variants is required");
  }

  const shopCurrencyCode = await getShopCurrencyCode(admin);
  console.log("[bundle] updateBundle: updating or creating product pools...");
  const productPoolMetaobjectIds = await getOrUpdateProductPoolMetaobjectIds(
    admin,
    formState.productPools,
    bundleConfigId
  );
  console.log("[bundle] updateBundle: updating bundle_config metaobject...");
  await updateBundleConfigMetaobject(
    admin,
    bundleConfigId,
    formState,
    productPoolMetaobjectIds,
    shopCurrencyCode
  );
  console.log("[bundle] updateBundle: updating product...");
  await updateBundleProduct(admin, productId, formState.bundleName, bundleConfigId);

  const variantId = await getFirstVariantIdForProduct(admin, productId);
  const { id: cartTransformId, bundleConfigJson } = await getOrCreateCartTransform(admin);
  console.log("[bundle] updateBundle: cartTransformId =", cartTransformId, "existing bundles count =", (bundleConfigJson?.bundles ?? []).length);
  const updatedBundle = buildBundleConfigJson(
    formState,
    productId,
    variantId,
    bundleConfigId,
    formState.productPools
  );
  const productIdNum = String(productId).replace(/.*\//, "");
  const existingBundles = bundleConfigJson?.bundles ?? [];
  const bundles = existingBundles.map((b) => {
    const bPid = b.productId ?? "";
    const match = bPid === productId || bPid.endsWith(`/${productIdNum}`);
    return match ? updatedBundle : b;
  });
  if (!bundles.some((b) => (b.productId ?? "").endsWith(`/${productIdNum}`) || b.productId === productId)) {
    console.log("[bundle] updateBundle: product not in list, appending updated bundle");
    bundles.push(updatedBundle);
  }
  console.log("[bundle] updateBundle: setting cart transform bundles, final count =", bundles.length);
  await setCartTransformBundles(admin, cartTransformId, bundles);
  console.log("[bundle] updateBundle: done");
}

/**
 * Create a full bundle: metaobjects, product, and cart transform metafield
 * @param {object} admin - Shopify Admin API client
 * @param {object} formState - form data from the create bundle UI
 * @returns {Promise<{productId: string, bundleConfigId: string}>}
 */
export async function createBundle(admin, formState) {
  if (!formState.bundleName?.trim()) {
    throw new Error("Bundle name is required");
  }
  if (!formState.productPools?.length || formState.productPools.every((p) => !p.variants?.length)) {
    throw new Error("At least one product pool with variants is required");
  }

  const shopCurrencyCode = await getShopCurrencyCode(admin);
  const productPoolMetaobjectIds = await createProductPoolMetaobjects(admin, formState.productPools);
  const bundleConfigId = await createBundleConfigMetaobject(
    admin,
    formState,
    productPoolMetaobjectIds,
    shopCurrencyCode
  );
  await setBundleConfigIdOnProductPools(admin, productPoolMetaobjectIds, bundleConfigId);
  const productId = await createBundleProduct(admin, formState.bundleName, bundleConfigId);
  const variantId = await getFirstVariantIdForProduct(admin, productId);

  const { id: cartTransformId, bundleConfigJson } = await getOrCreateCartTransform(admin);
  const newBundle = buildBundleConfigJson(
    formState,
    productId,
    variantId,
    bundleConfigId,
    formState.productPools
  );
  await updateCartTransformBundleConfig(admin, cartTransformId, bundleConfigJson, newBundle);

  return { productId, bundleConfigId };
}
