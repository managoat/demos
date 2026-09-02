# salvage

Unmerged work from the fourteen repositories that became this one, kept here
because it was too large to survive as an issue body and the repositories it
lived in have been deleted.

| File | From | Issue |
| --- | --- | --- |
| `fountain-workbench-pr-32.diff` | managoat/fountain-workbench#32, "A standing proposal is visible without opening the item" | [#7](https://github.com/managoat/demos/issues/7) |

The diffs are against the pre-move layout, so paths need `apps/<name>/`
prefixing to apply:

```bash
git apply --directory=apps/fountain-workbench salvage/fountain-workbench-pr-32.diff
```

Delete a file once its issue is resolved, either way. Nothing builds from
this directory — `scripts/apps.ts` reads `apps/` only, so nothing here
reaches CI or the cluster.
