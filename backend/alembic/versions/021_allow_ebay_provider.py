"""Allow 'ebay' in provider check constraints.

The eBay integration (020) writes provider='ebay' to external links, sync runs
and reconciliation issues, but the check constraints from 009/010 only allowed
lightspeed, square, clover and spreadsheet, so every eBay sync was rejected.

Revision ID: 021
Revises: 020
"""
from alembic import op

revision = "021"
down_revision = "020"
branch_labels = None
depends_on = None

OLD_PROVIDERS = "provider IN ('lightspeed','square','clover','spreadsheet')"
NEW_PROVIDERS = "provider IN ('lightspeed','square','clover','ebay','spreadsheet')"

# (table, constraint name)
CONSTRAINTS = [
    ("inventory_external_links", "ck_ext_link_provider"),
    ("provider_sync_runs", "ck_provider_sync_runs_provider"),
    ("reconciliation_issues", "ck_recon_issues_provider"),
]


def upgrade() -> None:
    for table, name in CONSTRAINTS:
        op.drop_constraint(name, table, type_="check")
        op.create_check_constraint(name, table, NEW_PROVIDERS)


def downgrade() -> None:
    # Fails if any eBay rows exist; remove them first if you really need to roll back.
    for table, name in CONSTRAINTS:
        op.drop_constraint(name, table, type_="check")
        op.create_check_constraint(name, table, OLD_PROVIDERS)
