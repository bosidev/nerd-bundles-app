// @ts-check

/**
 * @typedef {import("../generated/api").CartTransformRunInput} CartTransformRunInput
 * @typedef {import("../generated/api").CartTransformRunResult} CartTransformRunResult
 */

/**
 * @type {CartTransformRunResult}
 */
const NO_CHANGES = {
  operations: [],
};

/**
 * @param {CartTransformRunInput} input
 * @returns {CartTransformRunResult}
 */
export function cartTransformRun(input) {
  const jsonValue = input.cartTransform?.bundleConfigJson?.jsonValue;

  // Set of variant IDs that are part of any bundle in the config
  const configVariantIds = new Set();
  const bundles = jsonValue?.bundles ?? [];
  for (const bundle of bundles) {
    const pools = bundle.productPools ?? [];
    for (const pool of pools) {
      const ids = pool.variantIds ?? [];
      for (const id of ids) configVariantIds.add(id);
    }
  }

  const bundleLines = input.cart.lines.filter((line) => {
    const variantId = line.merchandise?.id;
    const bundleId = line.bundleIdAttr?.value;
    const bundleName = line.bundleNameAttr?.value;
    const bundleSize = line.bundleSizeAttr?.value;
    return (
      variantId &&
      configVariantIds.has(variantId) &&
      bundleId &&
      bundleName &&
      bundleSize
    );
  });

  if (bundleLines.length === 0) {
    return NO_CHANGES;
  }

  let operations = [];

  // Group by same _bundleId and _bundleName (bundleName later selects which bundle config to use)
  const groups = bundleLines.reduce((acc, line) => {
    const bundleId = line.bundleIdAttr?.value;
    const bundleName = line.bundleNameAttr?.value;
    if (!bundleId || !bundleName) return acc;
    const groupKey = `${bundleId}\0${bundleName}`;
    if (!acc[groupKey]) acc[groupKey] = [];
    acc[groupKey].push(line);
    return acc;
  }, /** @type {{ [key: string]: typeof bundleLines }} */ ({}));

  for (const groupKey of Object.keys(groups)) {
    const group = groups[groupKey];
    const [bundleId, bundleName] = groupKey.split("\0");

    if (group.length > 0) {
      // Resolve bundle config by _bundleName for this group (used for fixedPrice, size, etc.)
      const bundleConfig = bundles.find((b) => (b.bundleName ?? "") === bundleName);
      const parentId = bundleConfig.variantId;
      const priceType = bundleConfig.priceType;
      const size = Number(group[0].bundleSizeAttr?.value ?? 1);
      const fixedPriceAmount = bundleConfig?.fixedPrice ?? 0;
      const discountPercentage = bundleConfig?.discountPercent ?? 0;

      const totalSum = group
        .map((line) => line.cost.totalAmount.amount) // Extract the prices
        .reduce((acc, price) => acc + parseFloat(price), 0) // Sum the prices
        .toFixed(2); // Always two decimals, including 00

      const totalQuantity = group.reduce((accumulator, line) => {
        return accumulator + line.quantity;
      }, 0);

      const bundleSizes = totalQuantity / size;

      if (!Number.isInteger(bundleSizes)) {
        continue;
      }

      const operationLines = group.map((line) => {
        return {
          cartLineId: line.id,
          quantity: line.quantity / bundleSizes,
        };
      });

      const fixedPrice = parseFloat(fixedPriceAmount);
      const totalSumNumber = parseFloat(totalSum);
      // Fixed: compute % decrease from total sum to fixed price. Discounted: use discountPercentage. Original: no decrease.
      let percentage;
      if (priceType === "fixed") {
        percentage =
          ((totalSumNumber - fixedPrice * bundleSizes) / totalSumNumber) * 100;
      } else if (priceType === "discounted") {
        percentage = parseFloat(discountPercentage);
      } else {
        percentage = 0;
      }

      const operationObject = {
        linesMerge: {
          cartLines: operationLines,
          parentVariantId: parentId,
          price: {
            percentageDecrease: {
              value: percentage,
            },
          },
          attributes: [
            {
              key: "_bundleId",
              value: bundleId,
            },
            {
              key: "_bundleName",
              value: bundleName,
            },
            {
              key: "_originalPrice",
              value: `${totalSum.replace(".", "")}`,
            },
          ],
        },
      };

      operations.push(operationObject);
    }
  }

  if (operations.length > 0) {
    return {
      operations,
    };
  } else {
    return NO_CHANGES;
  }
}
