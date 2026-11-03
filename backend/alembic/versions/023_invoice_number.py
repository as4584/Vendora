"""Store a per-user sequential invoice number.

Previously the number on the PDF was recomputed on every download by counting
the user's invoices, so it could change. Existing invoices are numbered in
creation order, which matches what their PDFs showed.

Revision ID: 023
Revises: 022
"""
from alembic import op
import sqlalchemy as sa

revision = "023"
down_revision = "022"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("invoices", sa.Column("number", sa.Integer(), nullable=True))
    op.execute(
        """
        UPDATE invoices AS i
        SET number = ranked.seq
        FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at, id) AS seq
            FROM invoices
        ) AS ranked
        WHERE i.id = ranked.id
        """
    )
    op.alter_column("invoices", "number", nullable=False)
    op.create_unique_constraint("uq_invoices_user_number", "invoices", ["user_id", "number"])


def downgrade() -> None:
    op.drop_constraint("uq_invoices_user_number", "invoices", type_="unique")
    op.drop_column("invoices", "number")
