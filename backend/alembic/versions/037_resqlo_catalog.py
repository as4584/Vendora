"""Resqlo universal catalog.

Revision ID: 037c
Revises: 036b
"""
from alembic import op
import sqlalchemy as sa

revision = "037c"
down_revision = "036b"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "catalog_products",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("rq_code", sa.String(16), nullable=False),
        sa.Column("style_code", sa.String(64), nullable=False),
        sa.Column("size", sa.String(32), nullable=False, server_default=""),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("brand", sa.String(200), nullable=True),
        sa.Column("category", sa.String(200), nullable=True),
        sa.Column("color", sa.String(200), nullable=True),
        sa.Column("times_confirmed", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("rq_code", name="uq_catalog_products_rq_code"),
        sa.UniqueConstraint("style_code", "size", name="uq_catalog_products_style_size"),
    )
    op.create_index("ix_catalog_products_style", "catalog_products", ["style_code"])
    op.create_table(
        "catalog_barcodes",
        sa.Column("code", sa.String(64), primary_key=True),
        sa.Column("product_id", sa.Uuid(), sa.ForeignKey("catalog_products.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_catalog_barcodes_product_id", "catalog_barcodes", ["product_id"])


def downgrade() -> None:
    op.drop_index("ix_catalog_barcodes_product_id", table_name="catalog_barcodes")
    op.drop_table("catalog_barcodes")
    op.drop_index("ix_catalog_products_style", table_name="catalog_products")
    op.drop_table("catalog_products")
