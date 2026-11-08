"""Google Sheets sync: OAuth tokens, linked sheet, provider='google_sheets'.

Revision ID: 033
Revises: 032
"""
from alembic import op
import sqlalchemy as sa

revision = "033"
down_revision = "032"
branch_labels = None
depends_on = None

OLD_PROVIDERS = "provider IN ('lightspeed','square','clover','ebay','stockx','spreadsheet')"
NEW_PROVIDERS = "provider IN ('lightspeed','square','clover','ebay','stockx','spreadsheet','google_sheets')"

CONSTRAINTS = [
    ("inventory_external_links", "ck_ext_link_provider"),
    ("provider_sync_runs", "ck_provider_sync_runs_provider"),
    ("reconciliation_issues", "ck_recon_issues_provider"),
]


def _timestamps():
    return [
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    ]


def upgrade() -> None:
    for table, name in CONSTRAINTS:
        op.drop_constraint(name, table, type_="check")
        op.create_check_constraint(name, table, NEW_PROVIDERS)

    op.create_table(
        "google_tokens",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("email", sa.String(255), nullable=True),
        sa.Column("access_token", sa.String(8192), nullable=False),
        sa.Column("refresh_token", sa.String(4096), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("scopes", sa.String(1024), nullable=True),
        *_timestamps(),
    )
    op.create_index("ix_google_tokens_user_id", "google_tokens", ["user_id"], unique=True)

    op.create_table(
        "google_sheet_links",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("spreadsheet_id", sa.String(255), nullable=False),
        sa.Column("spreadsheet_title", sa.String(255), nullable=True),
        sa.Column("spreadsheet_url", sa.String(1024), nullable=True),
        sa.Column("sheet_tab", sa.String(255), nullable=False),
        sa.Column("sheet_gid", sa.Integer(), nullable=True),
        sa.Column("header_map", sa.JSON(), nullable=False),
        sa.Column("row_state", sa.JSON(), nullable=False),
        sa.Column("last_values_hash", sa.String(64), nullable=True),
        sa.Column("last_synced_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("source_of_truth", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("archive_missing", sa.Boolean(), nullable=False, server_default=sa.false()),
        *_timestamps(),
    )
    op.create_index("ix_google_sheet_links_user_id", "google_sheet_links", ["user_id"], unique=True)


def downgrade() -> None:
    op.drop_table("google_sheet_links")
    op.drop_table("google_tokens")
    op.execute("DELETE FROM reconciliation_issues WHERE provider = 'google_sheets'")
    op.execute("DELETE FROM provider_sync_runs WHERE provider = 'google_sheets'")
    op.execute("DELETE FROM inventory_external_links WHERE provider = 'google_sheets'")
    op.execute("DELETE FROM provider_outbox WHERE provider = 'google_sheets'")
    for table, name in CONSTRAINTS:
        op.drop_constraint(name, table, type_="check")
        op.create_check_constraint(name, table, OLD_PROVIDERS)
