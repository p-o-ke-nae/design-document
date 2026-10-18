namespace OrderApp.WinForms.Screens;

partial class ListScreen
{
    private System.ComponentModel.IContainer components = null;

    protected override void Dispose(bool disposing)
    {
        if (disposing && (components != null))
        {
            components.Dispose();
        }
        base.Dispose(disposing);
    }

    #region Component Designer generated code

    private void InitializeComponent()
    {
        this.title = new System.Windows.Forms.Label();
        this.orders = new System.Windows.Forms.DataGridView();
        this.idColumn = new System.Windows.Forms.DataGridViewTextBoxColumn();
        this.customerColumn = new System.Windows.Forms.DataGridViewTextBoxColumn();
        this.skuColumn = new System.Windows.Forms.DataGridViewTextBoxColumn();
        this.quantityColumn = new System.Windows.Forms.DataGridViewTextBoxColumn();
        this.statusColumn = new System.Windows.Forms.DataGridViewTextBoxColumn();
        this.newButton = new System.Windows.Forms.Button();
        ((System.ComponentModel.ISupportInitialize)(this.orders)).BeginInit();
        this.SuspendLayout();
        //
        // title
        //
        this.title.AutoSize = true;
        this.title.Font = new System.Drawing.Font("Yu Gothic UI", 13F, System.Drawing.FontStyle.Bold);
        this.title.Location = new System.Drawing.Point(0, 0);
        this.title.Name = "title";
        this.title.Size = new System.Drawing.Size(82, 25);
        this.title.TabIndex = 0;
        this.title.Text = "注文一覧";
        //
        // orders
        //
        this.orders.AllowUserToAddRows = false;
        this.orders.AllowUserToDeleteRows = false;
        this.orders.Anchor = ((System.Windows.Forms.AnchorStyles)((((System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Bottom)
        | System.Windows.Forms.AnchorStyles.Left)
        | System.Windows.Forms.AnchorStyles.Right)));
        this.orders.AutoSizeColumnsMode = System.Windows.Forms.DataGridViewAutoSizeColumnsMode.Fill;
        this.orders.BackgroundColor = System.Drawing.SystemColors.Window;
        this.orders.Columns.AddRange(new System.Windows.Forms.DataGridViewColumn[] {
        this.idColumn,
        this.customerColumn,
        this.skuColumn,
        this.quantityColumn,
        this.statusColumn});
        this.orders.Location = new System.Drawing.Point(0, 36);
        this.orders.Name = "orders";
        this.orders.ReadOnly = true;
        this.orders.RowHeadersVisible = false;
        this.orders.SelectionMode = System.Windows.Forms.DataGridViewSelectionMode.FullRowSelect;
        this.orders.Size = new System.Drawing.Size(592, 280);
        this.orders.TabIndex = 1;
        //
        // idColumn
        //
        this.idColumn.DataPropertyName = "Id";
        this.idColumn.FillWeight = 40F;
        this.idColumn.HeaderText = "番号";
        this.idColumn.Name = "idColumn";
        this.idColumn.ReadOnly = true;
        //
        // customerColumn
        //
        this.customerColumn.DataPropertyName = "Customer";
        this.customerColumn.FillWeight = 120F;
        this.customerColumn.HeaderText = "顧客名";
        this.customerColumn.Name = "customerColumn";
        this.customerColumn.ReadOnly = true;
        //
        // skuColumn
        //
        this.skuColumn.DataPropertyName = "Sku";
        this.skuColumn.FillWeight = 60F;
        this.skuColumn.HeaderText = "商品";
        this.skuColumn.Name = "skuColumn";
        this.skuColumn.ReadOnly = true;
        //
        // quantityColumn
        //
        this.quantityColumn.DataPropertyName = "Quantity";
        this.quantityColumn.FillWeight = 40F;
        this.quantityColumn.HeaderText = "数量";
        this.quantityColumn.Name = "quantityColumn";
        this.quantityColumn.ReadOnly = true;
        //
        // statusColumn
        //
        this.statusColumn.DataPropertyName = "Status";
        this.statusColumn.FillWeight = 70F;
        this.statusColumn.HeaderText = "状態";
        this.statusColumn.Name = "statusColumn";
        this.statusColumn.ReadOnly = true;
        //
        // newButton（new は C# のキーワードなのでフィールド名だけ変え、Name を論理名にする）
        //
        this.newButton.Anchor = ((System.Windows.Forms.AnchorStyles)((System.Windows.Forms.AnchorStyles.Bottom | System.Windows.Forms.AnchorStyles.Left)));
        this.newButton.Location = new System.Drawing.Point(0, 328);
        this.newButton.Name = "new";
        this.newButton.Size = new System.Drawing.Size(96, 30);
        this.newButton.TabIndex = 2;
        this.newButton.Text = "新規";
        this.newButton.UseVisualStyleBackColor = true;
        this.newButton.Click += new System.EventHandler(this.newButton_Click);
        //
        // ListScreen
        //
        this.AutoScaleDimensions = new System.Drawing.SizeF(7F, 15F);
        this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
        this.Controls.Add(this.title);
        this.Controls.Add(this.orders);
        this.Controls.Add(this.newButton);
        this.Name = "List";
        this.Size = new System.Drawing.Size(592, 365);
        ((System.ComponentModel.ISupportInitialize)(this.orders)).EndInit();
        this.ResumeLayout(false);
        this.PerformLayout();
    }

    #endregion

    private System.Windows.Forms.Label title;
    private System.Windows.Forms.DataGridView orders;
    private System.Windows.Forms.DataGridViewTextBoxColumn idColumn;
    private System.Windows.Forms.DataGridViewTextBoxColumn customerColumn;
    private System.Windows.Forms.DataGridViewTextBoxColumn skuColumn;
    private System.Windows.Forms.DataGridViewTextBoxColumn quantityColumn;
    private System.Windows.Forms.DataGridViewTextBoxColumn statusColumn;
    private System.Windows.Forms.Button newButton;
}
